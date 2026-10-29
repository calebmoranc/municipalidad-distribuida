import env from '#start/env'
import { pedir } from '#services/cliente_http'
import { Interruptor } from '#services/interruptor'
import { enviar, recibir } from '#services/reloj_logico'
import { crearIdentidadServicio } from '#services/identidad'

/**
 * `existe`          el tramite esta y la respuesta fue 200
 * `no_existe`       el servicio respondio 404
 * `sin_respuesta`   no se llego a preguntar: circuito abierto o fallo de red
 * `error`           el servicio respondio algo que no es 200 ni 404
 *
 * Se conservan los cuatro resultados porque el controlador responde con mensajes
 * distintos para cada caso, y ese contrato ya estaba publicado.
 *
 * Cada llamada lleva el sello del reloj logico de este proceso y sincroniza el
 * reloj con el que devuelve tramites.
 *
 * El circuito evita que cada peticion del cliente vuelva a pagar la espera
 * completa mientras tramites esta caido.
 */
export const circuitoTramites = new Interruptor('tramites')

function urlTramite(idTramite: string): string {
  return `${env.get('TRAMITES_SERVICE_URL')}/api/v1/tramites/${idTramite}`
}

export async function consultarTramite(
  idTramite: string
): Promise<'existe' | 'no_existe' | 'sin_respuesta' | 'error'> {
  try {
    const respuesta = await circuitoTramites.ejecutar(async () => {
      const r = await pedir({
        url: urlTramite(idTramite),
        dependencia: 'tramites',
        headers: {
          ...enviar().cabeceras,
          'X-Identidad': crearIdentidadServicio(),
        },
      })

      recibir(r.headers.get('X-Lamport'))

      // Un 5xx hay que lanzarlo dentro de la operacion. Si se devuelve aqui, el
      // interruptor lo contaria como exito (la llamada HTTP si tuvo exito, solo
      // que con un mal codigo) y nunca abriria el circuito.
      if (r.status >= 500) {
        throw new Error(`Tramites respondio ${r.status}`)
      }

      return r
    })

    if (respuesta.status === 404) {
      return 'no_existe'
    }

    return respuesta.ok ? 'existe' : 'error'
  } catch {
    // Circuito abierto o fallo de red: no se llego a obtener respuesta.
    return 'sin_respuesta'
  }
}

/**
 * Devuelve el estado del trámite, o null si no se pudo saber.
 *
 * Lo usa el reconciliador para decidir si una operación interrumpida llegó a
 * completarse. No es el camino caliente, por eso va por HTTP y no con una copia
 * local: los datos de tramites viven en otra base y no hay JOIN posible.
 */
export async function obtenerEstadoTramite(idTramite: string): Promise<string | null> {
  try {
    const resultado = await circuitoTramites.ejecutar(async () => {
      const r = await pedir({
        url: urlTramite(idTramite),
        dependencia: 'tramites',
        headers: {
          ...enviar().cabeceras,
          'X-Identidad': crearIdentidadServicio(),
        },
      })

      recibir(r.headers.get('X-Lamport'))

      if (r.status === 404) {
        return null
      }

      if (r.status >= 500) {
        throw new Error(`Tramites respondio ${r.status}`)
      }

      if (!r.ok) {
        return null
      }

      return ((await r.json()) as { estado?: string }).estado ?? null
    })

    return resultado
  } catch {
    return null
  }
}

/**
 * Marca el tramite como pagado. Devuelve si la operacion se completo.
 *
 * Si el circuito esta abierto devuelve false sin llamar a nadie, para que el
 * controlador aplique la compensacion y no deje pagos huerfanos.
 */
export async function marcarTramitePagado(idTramite: string): Promise<boolean> {
  try {
    return await circuitoTramites.ejecutar(async () => {
      const r = await pedir({
        url: urlTramite(idTramite),
        dependencia: 'tramites',
        method: 'PATCH',
        headers: {
          ...enviar().cabeceras,
          'Content-Type': 'application/json',
          'X-Identidad': crearIdentidadServicio(),
        },
        body: JSON.stringify({ estado: 'pagado' }),
      })

      recibir(r.headers.get('X-Lamport'))

      if (r.status >= 500) {
        throw new Error(`Tramites respondio ${r.status}`)
      }

      return r.ok
    })
  } catch {
    return false
  }
}

/**
 * Lectura completa que necesita el flujo de pagos: además de existir, interesa
 * quién es el dueño y en qué estado está.
 *
 * `consultarTramite` se mantiene porque responde a otra pregunta (solo
 * existencia); esta devuelve lo necesario para decidir si un ciudadano puede
 * pagar ese trámite.
 */
export type TramiteLeido =
  | { resultado: 'existe'; usuarioId: string; estado: string }
  | { resultado: 'no_existe' }
  | { resultado: 'sin_respuesta' }
  | { resultado: 'error' }

export async function leerTramite(idTramite: string): Promise<TramiteLeido> {
  try {
    const respuesta = await circuitoTramites.ejecutar(async () => {
      const r = await pedir({
        url: urlTramite(idTramite),
        dependencia: 'tramites',
        headers: {
          ...enviar().cabeceras,
          'X-Identidad': crearIdentidadServicio(),
        },
      })

      recibir(r.headers.get('X-Lamport'))

      if (r.status >= 500) {
        throw new Error(`Tramites respondio ${r.status}`)
      }

      return r
    })

    if (respuesta.status === 404) return { resultado: 'no_existe' }
    if (!respuesta.ok) return { resultado: 'error' }

    const datos = (await respuesta.json()) as { usuarioId?: string; estado?: string }

    if (typeof datos.usuarioId !== 'string') return { resultado: 'error' }

    return {
      resultado: 'existe',
      usuarioId: datos.usuarioId,
      estado: datos.estado ?? 'pendiente',
    }
  } catch {
    return { resultado: 'sin_respuesta' }
  }
}
