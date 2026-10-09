import type { HttpContext } from '@adonisjs/core/http'
import Pago from '#models/pago'
import { consultarUsuario } from '#services/usuarios_client'
import env from '#start/env'

export default class PagosController {
  async index() {
    return await Pago.all()
  }

  async store({ request, response }: HttpContext) {
    const datos = request.only([
      'id_tramite',
      'usuario_id',
      'monto',
      'metodo_pago',
      'fecha_pago',
      'estado',
    ])

    // La API pública usa snake_case y el modelo declara camelCase. Lucid sí
    // resuelve las claves por nombre de columna, pero lo mapeamos aquí para que
    // quede explícito qué se guarda y para no depender de ese comportamiento.
    const idTramite = Number(datos.id_tramite)
    const usuarioId = Number(datos.usuario_id)

    const tramitesUrl = env.get('TRAMITES_SERVICE_URL')

    // 1. Verificar que el trámite exista
    try {
      const tramiteResponse = await fetch(`${tramitesUrl}/api/v1/tramites/${idTramite}`)

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

    // 2. Verificar que el usuario exista contra el servicio usuarios. Va después
    //    de validar el trámite para no gastar una llamada si el pago ya es inválido.
    if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
      return response.badRequest({
        mensaje: 'El usuario indicado no es válido',
      })
    }

    try {
      const existe = await consultarUsuario(usuarioId)

      if (!existe) {
        return response.badRequest({
          mensaje: 'El usuario indicado no existe',
        })
      }
    } catch {
      return response.serviceUnavailable({
        mensaje: 'No se pudo verificar el usuario',
      })
    }

    // 3. Crear el pago
    const pago = await Pago.create({
      idTramite,
      usuarioId,
      monto: datos.monto,
      metodoPago: datos.metodo_pago,
      fechaPago: datos.fecha_pago,
      estado: datos.estado,
    })

    // 4. Actualizar el estado del trámite
    try {
      const actualizarTramite = await fetch(`${tramitesUrl}/api/v1/tramites/${idTramite}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          estado: 'pagado',
        }),
      })

      // 5. Si Trámites no pudo actualizarse, eliminar el pago
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

    // 6. Todo salió correctamente
    return response.created(pago)
  }
}
