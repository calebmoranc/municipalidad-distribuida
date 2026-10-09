import Pago from '#models/pago'
import { idNodo, tick } from '#services/reloj_logico'
import { consultarTramite, marcarTramitePagado } from '#services/tramites_client'
import { consultarUsuario } from '#services/usuarios_client'
import type { HttpContext } from '@adonisjs/core/http'

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

    // 1. Verificar que el trámite exista
    const tramite = await consultarTramite(idTramite)

    if (tramite === 'no_existe') {
      return response.badRequest({
        mensaje: 'El trámite indicado no existe',
      })
    }

    if (tramite === 'sin_respuesta') {
      return response.serviceUnavailable({
        mensaje: 'No se pudo conectar con el servicio de trámites',
      })
    }

    if (tramite === 'error') {
      return response.serviceUnavailable({
        mensaje: 'No se pudo verificar el trámite',
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

    // 3. Crear el pago. El sello se toma despues de las llamadas anteriores, que
    //    ya hicieron avanzar el reloj de esta replica.
    const pago = await Pago.create({
      idTramite,
      usuarioId,
      monto: datos.monto,
      metodoPago: datos.metodo_pago,
      fechaPago: datos.fecha_pago,
      estado: datos.estado,
      lamport: tick(),
      nodeId: idNodo(),
    })

    // 4. Actualizar el estado del trámite
    const actualizado = await marcarTramitePagado(idTramite)

    // 5. Si Trámites no pudo actualizarse, eliminar el pago (compensación)
    if (!actualizado) {
      await pago.delete()

      return response.serviceUnavailable({
        mensaje: 'No se pudo actualizar el trámite. El pago fue eliminado.',
      })
    }

    // 6. Todo salió correctamente
    return response.created(pago)
  }
}