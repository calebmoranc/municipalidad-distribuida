import env from '#start/env'
import { enviar, recibir } from '#services/reloj_logico'

/**
 * Cliente del servicio tramites.
 *
 * `existe`          el tramite esta y la respuesta fue 200
 * `no_existe`       el servicio respondio 404
 * `sin_respuesta`   no hubo conexion (red caida o timeout)
 * `error`           el servicio respondio algo que no es 200 ni 404
 *
 * La distincion entre `sin_respuesta` y `error` se conserva porque el controlador
 * responde con mensajes distintos para cada caso.
 *
 * Cada llamada lleva el sello del reloj logico de este proceso y sincroniza el
 * reloj con el que devuelve tramites.
 */
export async function consultarTramite(
  idTramite: number
): Promise<'existe' | 'no_existe' | 'sin_respuesta' | 'error'> {
  const url = `${env.get('TRAMITES_SERVICE_URL')}/api/v1/tramites/${idTramite}`

  let respuesta: Response

  try {
    respuesta = await fetch(url, { headers: enviar().cabeceras })
  } catch {
    return 'sin_respuesta'
  }

  recibir(respuesta.headers.get('X-Lamport'))

  if (respuesta.status === 404) {
    return 'no_existe'
  }

  if (!respuesta.ok) {
    return 'error'
  }

  return 'existe'
}

/**
 * Marca el tramite como pagado. Devuelve si la operacion se completo.
 */
export async function marcarTramitePagado(idTramite: number): Promise<boolean> {
  const url = `${env.get('TRAMITES_SERVICE_URL')}/api/v1/tramites/${idTramite}`

  const mensaje = enviar()

  let respuesta: Response

  try {
    respuesta = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...mensaje.cabeceras,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        estado: 'pagado',
      }),
    })
  } catch {
    return false
  }

  recibir(respuesta.headers.get('X-Lamport'))

  return respuesta.ok
}
