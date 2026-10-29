import Pago from '#models/pago'
import PagoIntento from '#models/pago_intento'
import env from '#start/env'
import { idNodo, tick } from '#services/reloj_logico'
import { leerTramite, marcarTramitePagado } from '#services/tramites_client'
import { consultarUsuario } from '#services/usuarios_client'
import { siguienteCodigo } from '#services/codigos'
import { esPrivilegiado, leerIdentidad } from '#services/identidad'
import type { HttpContext } from '@adonisjs/core/http'

const DNI = /^\d{8}$/
const CODIGO_TRAMITE = /^T\d{1,11}$/
const CODIGO_PAGO = /^P\d{1,11}$/

/**
 * Reglas de acceso:
 *
 *   ciudadano                 solicita pagos para sus propios trámites y solo ve
 *                             los suyos. El pago queda en 'pendiente'.
 *   personal_muni_tesoreria   ve todos los pagos y confirma/acredita
 *   admin                     igual que tesorería, y además es el rol máximo
 *
 * La confirmación es un paso aparte a propósito: registrar la solicitud y
 * acreditar el pago son responsabilidades distintas. Solo al confirmar se toca
 * el servicio de trámites y el trámite pasa a 'pagado'.
 *
 * El id del pago es un código legible: 'P' + secuencia (P1, P13, P333).
 */
export default class PagosController {
  async index({ request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    const query = Pago.query()

    if (!esPrivilegiado(identidad.rol)) {
      query.where('usuario_id', identidad.id)
    }

    return response.ok(await query.orderBy('id_pago', 'asc'))
  }

  /**
   * Registrar una SOLICITUD de pago.
   *
   * No marca el trámite como pagado ni crea una intención de saga: eso ocurre
   * cuando tesorería o el administrador confirman. Así un ciudadano no puede
   * acreditarse un pago por su cuenta.
   */
  async store({ request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    const datos = request.only(['id_tramite', 'usuario_id', 'monto', 'metodo_pago', 'fecha_pago'])

    const idTramite = String(datos.id_tramite ?? '')
    const monto = Number(datos.monto)

    if (!CODIGO_TRAMITE.test(idTramite)) {
      return response.badRequest({ mensaje: 'El trámite indicado no es válido' })
    }

    if (!Number.isFinite(monto) || monto <= 0) {
      return response.badRequest({ mensaje: 'El monto no es válido' })
    }

    if (!datos.metodo_pago || !datos.fecha_pago) {
      return response.badRequest({
        mensaje: 'El método de pago y la fecha son obligatorios',
      })
    }

    // 1. Verificar que el trámite exista y obtener su dueño y estado.
    const tramite = await leerTramite(idTramite)

    if (tramite.resultado === 'no_existe') {
      return response.badRequest({ mensaje: 'El trámite indicado no existe' })
    }

    if (tramite.resultado === 'sin_respuesta') {
      return response.serviceUnavailable({
        mensaje: 'No se pudo conectar con el servicio de trámites',
      })
    }

    if (tramite.resultado === 'error') {
      return response.serviceUnavailable({
        mensaje: 'No se pudo verificar el trámite',
      })
    }

    // 2. Un ciudadano solo puede pagar sus propios trámites.
    if (!esPrivilegiado(identidad.rol) && tramite.usuarioId !== identidad.id) {
      return response.forbidden({
        mensaje: 'El trámite no pertenece a tu cuenta',
      })
    }

    // 3. El usuario del pago lo impone la identidad, no el cliente.
    const usuarioId = esPrivilegiado(identidad.rol) ? String(datos.usuario_id ?? '') : identidad.id

    if (!DNI.test(usuarioId)) {
      return response.badRequest({ mensaje: 'El usuario indicado no es válido' })
    }

    // Los perfiles privilegiados pueden registrar un pago a nombre de otro
    // usuario (la persona acudió a la oficina), así que se comprueba que exista.
    // Al ciudadano no hace falta: su identidad ya está firmada por usuarios.
    if (esPrivilegiado(identidad.rol)) {
      try {
        const existe = await consultarUsuario(usuarioId)

        if (!existe) {
          return response.badRequest({ mensaje: 'El usuario indicado no existe' })
        }
      } catch {
        return response.serviceUnavailable({
          mensaje: 'No se pudo verificar el usuario',
        })
      }
    }

    // 4. La solicitud nace pendiente. La acreditación es otro paso.
    const pago = await Pago.create({
      idPago: await siguienteCodigo('P', 'pagos_num_seq'),
      idTramite,
      usuarioId,
      monto,
      metodoPago: datos.metodo_pago,
      fechaPago: datos.fecha_pago,
      estado: 'pendiente',
      lamport: tick(),
      nodeId: idNodo(),
    })

    return response.created(pago)
  }

  /**
   * Confirmar y acreditar un pago.
   *
   * Aquí es donde ocurre la operación de dos recursos (pago + trámite) y por
   * tanto donde tiene sentido la saga: se registra la intención, se marca el
   * trámite como pagado y, solo si eso sale bien, el pago queda 'pagado'.
   *
   * Si el proceso muere entre medias, el reconciliador retoma la intención y
   * termina el trabajo. El pago sigue pendiente hasta que eso ocurra.
   */
  async confirmar({ params, request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    if (!esPrivilegiado(identidad.rol)) {
      return response.forbidden({
        mensaje: 'Solo administración o tesorería puede confirmar pagos',
      })
    }

    const idPago = String(params.id ?? '')

    if (!CODIGO_PAGO.test(idPago)) {
      return response.badRequest({ mensaje: 'El pago indicado no es válido' })
    }

    const pago = await Pago.find(idPago)

    if (!pago) {
      return response.notFound({ mensaje: 'Pago no encontrado' })
    }

    // Idempotente: si ya estaba acreditado, no se vuelve a tocar el trámite.
    if (pago.estado === 'pagado') {
      return response.ok(pago)
    }

    if (pago.estado !== 'pendiente') {
      return response.badRequest({ mensaje: 'El pago no está pendiente' })
    }

    const tramite = await leerTramite(pago.idTramite)

    if (tramite.resultado === 'no_existe') {
      return response.badRequest({ mensaje: 'El trámite del pago no existe' })
    }

    if (tramite.resultado === 'sin_respuesta') {
      return response.serviceUnavailable({
        mensaje: 'No se pudo conectar con el servicio de trámites',
      })
    }

    if (tramite.resultado === 'error') {
      return response.serviceUnavailable({
        mensaje: 'No se pudo verificar el trámite',
      })
    }

    // Si el trámite ya estaba pagado, el efecto externo ya ocurrió: basta con
    // acreditar el pago sin volver a llamar a trámites.
    if (tramite.estado === 'pagado') {
      pago.estado = 'pagado'
      pago.lamport = tick()
      pago.nodeId = idNodo()
      await pago.save()

      return response.ok(pago)
    }

    // 1. Registrar la intención ANTES de tocar el otro servicio.
    const intento = await PagoIntento.create({
      idTramite: pago.idTramite,
      usuarioId: pago.usuarioId ?? identidad.id,
      pagoId: pago.idPago,
      estado: 'pendiente',
      lamport: tick(),
      nodeId: idNodo(),
    })

    // 2. Interruptor de fallos para la demostración: muere entre guardar la
    //    intención y avisar a trámites, que es la ventana a recuperar.
    if (env.get('PAGOS_FALLAR_ANTES_DE_PATCH') === '1') {
      process.exit(70)
    }

    // 3. Marcar el trámite como pagado.
    const actualizado = await marcarTramitePagado(pago.idTramite)

    if (!actualizado) {
      // No se borra el pago: queda pendiente y el reconciliador lo reintenta.
      // El ciudadano ya solicitó el pago; deshacerlo sin avisar sería peor.
      await intento
        .merge({
          estado: 'pendiente',
          ultimoError: 'no se pudo marcar el trámite como pagado',
        })
        .save()

      return response.serviceUnavailable({
        mensaje: 'No se pudo acreditar el pago. Queda pendiente y se reintentará.',
      })
    }

    // 4. Todo bien: intención confirmada y pago acreditado.
    await intento.merge({ estado: 'confirmado', ultimoError: null }).save()

    pago.estado = 'pagado'
    pago.lamport = tick()
    pago.nodeId = idNodo()
    await pago.save()

    return response.ok(pago)
  }
}
