import type { HttpContext } from '@adonisjs/core/http'
import Pago from '#models/pago'
import env from '#start/env'

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

    const tramitesUrl = env.get('TRAMITES_SERVICE_URL')

    // 1. Verificar que el trámite exista
    try {
      const tramiteResponse = await fetch(
        `${tramitesUrl}/api/v1/tramites/${datos.id_tramite}`
      )

      if (tramiteResponse.status === 404) {
        return response.badRequest({
          mensaje: 'El trámite indicado no existe',
        })
      }

      if (!tramiteResponse.ok) {
        return response.serviceUnavailable({
          mensaje: 'No se pudo verificar el trámite',
        })
      }
    } catch {
      return response.serviceUnavailable({
        mensaje: 'No se pudo conectar con el servicio de trámites',
      })
    }

    // 2. Crear el pago
    const pago = await Pago.create(datos)

    // 3. Actualizar el estado del trámite
    try {
      const actualizarTramite = await fetch(
        `${tramitesUrl}/api/v1/tramites/${datos.id_tramite}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            estado: 'pagado',
          }),
        }
      )

      // 4. Si Trámites no pudo actualizarse, eliminar el pago
      if (!actualizarTramite.ok) {
        await pago.delete()

        return response.serviceUnavailable({
          mensaje: 'No se pudo actualizar el trámite. El pago fue eliminado.',
        })
      }
    } catch {
      await pago.delete()

      return response.serviceUnavailable({
        mensaje: 'No se pudo actualizar el trámite. El pago fue eliminado.',
      })
    }

    // 5. Todo salió correctamente
    return response.created(pago)
  }
}
