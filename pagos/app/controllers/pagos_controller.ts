import type { HttpContext } from '@adonisjs/core/http'
import Pago from '#models/pago'

export default class PagosController {
  async index() {
    return await Pago.all()
  }

  async store({ request, response }: HttpContext) {
    const datos = request.only([
      'id_tramite',
      'monto',
      'metodo_pago',
      'fecha_pago',
      'estado',
    ])

    const pago = await Pago.create(datos)

    return response.created(pago)
  }
}