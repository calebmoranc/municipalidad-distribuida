import env from '#start/env'
import { pedir } from '#services/cliente_http'
import { Interruptor } from '#services/interruptor'
import { enviar, recibir } from '#services/reloj_logico'

/**
 * Cliente del servicio usuarios.
 *
 * No se valida el usuario leyendo sus datos ni confiando en lo que envio el
 * cliente: lo unico que se acepta es el codigo de respuesta del servicio usuarios.
 * Un 404 significa que no existe; cualquier otra cosa se propaga como exception
 * para que el controlador la distinga de un 404 real.
 */
export const circuitoUsuarios = new Interruptor('usuarios')

export async function consultarUsuario(usuarioId: string): Promise<boolean> {
  const url = `${env.get('USUARIOS_SERVICE_URL')}/api/v1/usuarios/${usuarioId}`

  const respuesta = await circuitoUsuarios.ejecutar(async () => {
    const r = await pedir({
      url,
      headers: enviar().cabeceras,
      dependencia: 'usuarios',
    })

    recibir(r.headers.get('X-Lamport'))

    if (r.status === 404) {
      return 404
    }

    if (!r.ok) {
      throw new Error(`El servicio de usuarios respondio ${r.status}`)
    }

    return 200
  })

  return respuesta === 200
}
