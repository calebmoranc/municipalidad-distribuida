import env from '#start/env'
import { enviar, recibir } from '#services/reloj_logico'

/**
 * Cliente del servicio usuarios.
 *
 * No se valida el usuario leyendo sus datos ni confiando en lo que envio el
 * cliente: lo unico que se acepta es el codigo de respuesta del servicio usuarios.
 * Un 404 significa que no existe; cualquier otra cosa (error de red, 5xx) se
 * propaga como exception para que el controlador la distinga de un 404 real.
 *
 * La llamada viaja con el sello del reloj logico de este proceso (evento de envio)
 * y el reloj se sincroniza con el que devuelve usuarios (evento de recepcion).
 */
export async function consultarUsuario(usuarioId: number): Promise<boolean> {
  const url = `${env.get('USUARIOS_SERVICE_URL')}/api/v1/usuarios/${usuarioId}`

  const mensaje = enviar()

  let respuesta: Response

  try {
    respuesta = await fetch(url, {
      headers: mensaje.cabeceras,
      // Sin esto, si el gateway se cuelga la peticion se queda esperando para
      // siempre. 5s es suficiente para una consulta local.
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new Error('No se pudo conectar con el servicio de usuarios')
  }

  recibir(respuesta.headers.get('X-Lamport'))

  if (respuesta.status === 404) {
    return false
  }

  if (!respuesta.ok) {
    throw new Error(`El servicio de usuarios respondio ${respuesta.status}`)
  }

  return true
}
