import TipoTramite from '#models/tipo_tramite'
import { leerIdentidad } from '#services/identidad'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Catálogo de tipos de trámite y sus montos.
 *
 *   GET    /api/v1/tipos-tramite        cualquier identidad (solo activos)
 *   POST   /api/v1/tipos-tramite        admin
 *   PATCH  /api/v1/tipos-tramite/:id    admin
 *   DELETE /api/v1/tipos-tramite/:id    admin
 */
export default class TiposTramiteController {
  async index({ request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    const query = TipoTramite.query()

    // El administrador puede pedir también los inactivos con ?todos=1.
    if (!(identidad.rol === 'admin' && request.input('todos') === '1')) {
      query.where('activo', true)
    }

    return response.ok(await query.orderBy('nombre', 'asc'))
  }

  async store({ request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    if (identidad.rol !== 'admin') {
      return response.forbidden({ message: 'Solo el administrador general gestiona los montos' })
    }

    const nombre = String(request.input('nombre') ?? '').trim()
    const monto = Number(request.input('monto'))

    if (!nombre) {
      return response.badRequest({ message: 'El nombre del tipo es obligatorio' })
    }

    if (!Number.isFinite(monto) || monto < 0) {
      return response.badRequest({ message: 'El monto no es válido' })
    }

    const existente = await TipoTramite.findBy('nombre', nombre)

    if (existente) {
      return response.conflict({ message: 'Ya existe un tipo con ese nombre' })
    }

    const tipo = await TipoTramite.create({ nombre, monto, activo: true })

    return response.created(tipo)
  }

  async update({ params, request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    if (identidad.rol !== 'admin') {
      return response.forbidden({ message: 'Solo el administrador general gestiona los montos' })
    }

    const tipo = await TipoTramite.find(params.id)

    if (!tipo) {
      return response.notFound({ message: 'Tipo de trámite no encontrado' })
    }

    if (request.input('nombre') !== undefined) {
      const nombre = String(request.input('nombre')).trim()

      if (!nombre) {
        return response.badRequest({ message: 'El nombre del tipo es obligatorio' })
      }

      tipo.nombre = nombre
    }

    if (request.input('monto') !== undefined) {
      const monto = Number(request.input('monto'))

      if (!Number.isFinite(monto) || monto < 0) {
        return response.badRequest({ message: 'El monto no es válido' })
      }

      tipo.monto = monto
    }

    if (request.input('activo') !== undefined) {
      tipo.activo = request.input('activo') === true || request.input('activo') === 'true'
    }

    await tipo.save()

    return response.ok(tipo)
  }

  async destroy({ params, request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    if (identidad.rol !== 'admin') {
      return response.forbidden({ message: 'Solo el administrador general gestiona los montos' })
    }

    const tipo = await TipoTramite.find(params.id)

    if (!tipo) {
      return response.notFound({ message: 'Tipo de trámite no encontrado' })
    }

    await tipo.delete()

    return response.ok({ message: 'Tipo eliminado', id: tipo.id })
  }
}
