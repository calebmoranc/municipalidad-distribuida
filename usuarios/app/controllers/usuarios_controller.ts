import User from '#models/user'
import { enviar, recibir } from '#services/reloj_logico'
import type { HttpContext } from '@adonisjs/core/http'

export default class UsuariosController {
  async index({ request, response }: HttpContext) {
    // Este servicio solo responde consultas, no produce eventos de negocio, pero
    // su reloj tambien avanza: recibe el sello de quien pregunta (regla L2) y
    // devuelve el suyo, que es un evento de envio.
    recibir(request.header('X-Lamport'))
    response.header('X-Lamport', String(enviar().lamport))

    return User.all() //lista los usuarios
  }

  async show({ params, request, response }: HttpContext) {
    recibir(request.header('X-Lamport'))
    response.header('X-Lamport', String(enviar().lamport))

    return User.findOrFail(params.id) //obtiene uno por ID o devuelve error 404.
  }
}
//La contraseña no se incluirá porque el modelo tiene serializeAs: null.
