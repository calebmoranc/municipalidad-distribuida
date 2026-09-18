import User from '#models/user'
import type { HttpContext } from '@adonisjs/core/http'

export default class UsuariosController {
  async index() {
    return User.all() //lista los usuarios
  }

  async show({ params }: HttpContext) {
    return User.findOrFail(params.id) //obtiene uno por ID o devuelve error 404.
  }
}
//La contraseña no se incluirá porque el modelo tiene serializeAs: null.