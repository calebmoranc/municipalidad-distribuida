import Tramite from '#models/tramite'
import type { HttpContext } from '@adonisjs/core/http'

export default class TramitesController {
  async store({ request, response }: HttpContext) {
    const data = request.only([
      'usuarioId',
      'tipo',
      'descripcion',
    ])

    const tramite = await Tramite.create(data)

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