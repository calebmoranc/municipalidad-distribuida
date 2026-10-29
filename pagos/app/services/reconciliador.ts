import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import Pago from '#models/pago'
import PagoIntento from '#models/pago_intento'
import { idNodo, tick } from '#services/reloj_logico'
import { marcarTramitePagado, obtenerEstadoTramite } from '#services/tramites_client'

/**
 * Reconciliador de pagos interrumpidos.
 *
 * EL PROBLEMA. `POST /pagos` toca dos recursos que no comparten transacción:
 * escribe en `pagos_db` y hace que `tramites` escriba en su propia base. Si el
 * proceso muere entre ambos pasos, el pago queda guardado y el trámite nunca se
 * marcó como pagado. Antes esto se tapaba con un `pago.delete()` dentro del propio
 * proceso, pero si el proceso ya está muerto ese delete no ocurre.
 *
 * LA SOLUCIÓN. Antes de hacer nada se persiste la intención en `pagos_intentos`.
 * Si el proceso muere, la fila queda en 'pendiente' y este reconciliador la
 * retoma al arrancar el servicio. Se llama reconciliador (de "reconciliation")
 * porque compara el estado real con el esperado y corrige la diferencia.
 *
 * CÓMO SE COORDINAN LAS DOS RÉPLICAS. Ambas ejecutan esto al arrancar. El idiom
 * `FOR UPDATE SKIP LOCKED` deja la fila bloqueada para la primera transacción que
 * la toque, y hace que la segunda se salte las ya bloqueadas en vez de esperar.
 * Así cada intención la atiende una sola réplica.
 *
 * ATOMICIDAD. Esto NO da atomicidad entre servicios: sigue habiendo una ventana
 * en la que el sistema está a medio camino. Lo que da es que esa ventana se cierra
 * sola, y que siempre queda registro de qué pasó.
 */

/** Intenciones más antiguas que este número de segundos se consideran abandonadas. */
const ANTIGUEDAD_POR_DEFECTO_SEG = 5

type Intencion = {
  id: number
  id_tramite: string
  usuario_id: string
  pago_id: string | null
}

function antiguedadMinima(): number {
  const valor = Number(env.get('PAGOS_INTENTOS_ANTIGUEDAD_SEG'))
  return Number.isFinite(valor) && valor > 0 ? valor : ANTIGUEDAD_POR_DEFECTO_SEG
}

/**
 * Intenta cerrar cada intención pendiente, mirando el estado real en vez de
 * asumir nada:
 *
 *   pago existe + trámite 'pagado'   -> 'confirmado'
 *   no llegó a crearse el pago       -> 'revertido' (no hay nada que deshacer)
 *   pago existe + trámite sin pagar  -> se intenta completar el PATCH
 *   el PATCH sigue fallando          -> se deja 'pendiente' y se cuenta el intento
 */
export async function reconciliar(): Promise<{
  confirmados: number
  revertidos: number
  pendientes: number
}> {
  let confirmados = 0
  let revertidos = 0
  let pendientes = 0

  // Sin transaction() a propósito: cada intención se cierra por separado, y que
  // un fallo en una no impida recuperar las demás.
  const tomadas = await tomarIntencionesPendientes()

  for (const fila of tomadas) {
    try {
      const estado = await obtenerEstadoTramite(fila.id_tramite)
      const pago = fila.pago_id ? await Pago.find(fila.pago_id) : null

      // El pago ya no existe: la operación se deshizo a sí misma antes de morir.
      if (!pago) {
        await marcar(fila, 'revertido', 'no se llegó a crear el pago')
        revertidos++
        continue
      }

      // El trámite ya está pagado y el pago existe: todo bien. Se acredita el
      // pago si la confirmación original murió antes de guardar ese cambio.
      if (estado === 'pagado') {
        await acreditarPago(pago)
        await marcar(fila, 'confirmado', 'el pago existe y su trámite ya estaba pagado')
        confirmados++
        continue
      }

      // El pago existe pero el trámite no está pagado: se intenta terminar la
      // operación antes de recurrir al clawback.
      if (await marcarTramitePagado(fila.id_tramite)) {
        await acreditarPago(pago)
        await marcar(fila, 'confirmado', 'el reconciliador completó el PATCH del trámite')
        confirmados++
        continue
      }

      // El servicio sigue sin responder. Se deja pendiente y se reintenta luego:
      // es preferible tardar más que borrar el pago sin poder confirmar el
      // trámite, porque eso deja al usuario pagando por nada.
      await marcar(fila, 'pendiente', 'el servicio de trámites sigue sin responder')
      pendientes++
    } catch (error) {
      // El error se guarda en la fila Y se registra. Tragárselo en silencio
      // haría que un fallo del reconciliador pasara desapercibido.
      logger.error(
        `reconciliacion de la intencion ${fila.id} fallo: ${String(error).slice(0, 200)}`
      )
      await marcar(fila, 'pendiente', String(error).slice(0, 500))
      pendientes++
    }
  }

  return { confirmados, revertidos, pendientes }
}

/**
 * Toma las intenciones pendientes que ninguna otra réplica esté tocando.
 * SKIP LOCKED es lo que evita que las dos procesen la misma fila.
 */
async function tomarIntencionesPendientes(): Promise<Intencion[]> {
  const resultado = await db.rawQuery(
    `
    SELECT id, id_tramite, usuario_id, pago_id
    FROM pagos_intentos
    WHERE estado = 'pendiente'
      AND updated_at < now() - make_interval(secs => ?)
    ORDER BY id
    LIMIT 20
    FOR UPDATE SKIP LOCKED
    `,
    [antiguedadMinima()]
  )

  return resultado.rows as Intencion[]
}

/**
 * Deja el pago como acreditado. La confirmación escribe dos cosas (trámite y
 * pago) y el proceso puede morir entre ambas; esto cierra la segunda mitad.
 */
async function acreditarPago(pago: Pago) {
  if (pago.estado === 'pagado') return

  pago.estado = 'pagado'
  pago.lamport = tick()
  pago.nodeId = idNodo()
  await pago.save()
}

async function marcar(
  fila: { id: number; pago_id: string | null },
  estado: string,
  motivo: string
) {
  // El clawback va antes que el cambio de estado: si se muere entre medias,
  // vuelve a quedar 'pendiente' y el siguiente intento lo recoge.
  if (estado === 'revertido' && fila.pago_id) {
    await Pago.query().where('id_pago', fila.pago_id).delete()
  }

  const actual = await PagoIntento.query().where('id', fila.id).first()

  await PagoIntento.query()
    .where('id', fila.id)
    .update({
      estado,
      ultimoError: motivo,
      lamport: tick(),
      nodeId: idNodo(),
      intentos: estado === 'pendiente' ? (actual?.intentos ?? 0) + 1 : (actual?.intentos ?? 0),
    })
}
