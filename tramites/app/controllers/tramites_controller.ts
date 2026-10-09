import Tramite from '#models/tramite'
import { consultarUsuario } from '#services/usuarios_client'
import type { HttpContext } from '@adonisjs/core/http'

export default class TramitesController {
  async store({ request, response }: HttpContext) {
    const data = request.only(['usuarioId', 'tipo', 'descripcion'])

    const usuarioId = Number(data.usuarioId)

    if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
      return response.badRequest({
        message: 'El usuario indicado no es valido',
      })
    }

    // Verificar contra el servicio usuarios que el usuario existe realmente.
    try {
      const existe = await consultarUsuario(usuarioId)

      if (!existe) {
        return response.badRequest({
          message: 'El usuario indicado no existe',
        })
      }
    } catch {
      return response.serviceUnavailable({
        message: 'No se pudo verificar el usuario',
      })
    }

    const tramite = await Tramite.create({ ...data, usuarioId })

    return response.created(tramite)
  }

  async index({ response }: HttpContext) {
    const tramites = await Tramite.all()

    return response.ok(tramites)
  }
  async show({ params, response }: HttpContext) {
    const tramite = await Tramite.find(params.id)

    if (!tramite) {
      return response.notFound({
        message: 'Trámite no encontrado',
      })
    }

    return response.ok(tramite)
  }
  async update({ params, request, response }: HttpContext) {
    const tramite = await Tramite.find(params.id)

    if (!tramite) {
      return response.notFound({
        message: 'Trámite no encontrado',
      })
    }

    const data = request.only(['estado'])

    tramite.estado = data.estado
    await tramite.save()

    return response.ok(tramite)
  }
}
