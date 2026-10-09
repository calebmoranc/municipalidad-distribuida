import Tramite from '#models/tramite'
import { idNodo, recibir, tick } from '#services/reloj_logico'
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
    // Esta llamada hace avanzar el reloj (evento de envio, de recepcion y de
    // respuesta), asi que el sello se toma despues, no antes.
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

    const tramite = await Tramite.create({
      ...data,
      usuarioId,
      lamport: tick(),
      nodeId: idNodo(),
    })

    response.header('X-Lamport', String(tramite.lamport))
    response.header('X-Node-Id', String(tramite.nodeId))

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

    // Esta llamada la hace pagos al orquestar el pago, asi que su sello debe
    // entrar en el reloj de esta replica: regla L2 de Lamport.
    recibir(request.header('X-Lamport'))

    tramite.estado = data.estado
    tramite.lamport = tick()
    tramite.nodeId = idNodo()
    await tramite.save()

    response.header('X-Lamport', String(tramite.lamport))
    response.header('X-Node-Id', String(tramite.nodeId))

    return response.ok(tramite)
  }
}