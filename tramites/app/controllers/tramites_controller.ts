import Tramite from '#models/tramite'
import TramiteEvento from '#models/tramite_evento'
import TipoTramite from '#models/tipo_tramite'
import Database from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { idNodo, recibir, tick } from '#services/reloj_logico'
import { consultarUsuario } from '#services/usuarios_client'
import { siguienteCodigo } from '#services/codigos'
import { ROLES, esPrivilegiado, leerIdentidad } from '#services/identidad'
import { ESTADOS, esEstadoValido, transicionPermitida } from '#services/estados'
import type { HttpContext } from '@adonisjs/core/http'

const DNI = /^\d{8}$/
const TIPO_OTRO = 'Otro'
const CLAVE_IDEMPOTENCIA = /^[A-Za-z0-9_-]{8,64}$/

/**
 * Reglas de acceso:
 *
 *   ciudadano                 ve solo sus trámites y crea trámites a su nombre
 *   personal_muni_tesoreria   ve todos y puede cambiar estados (no montos ni tipos)
 *   admin                     ve todos, crea/edita/borra trámites y gestiona el catálogo
 *   servicio                  lo usan pagos y el reconciliador para el PATCH
 *
 * La identidad llega en `X-Identidad`, firmada por usuarios. Se verifica aquí,
 * sin llamar a usuarios: si el servicio de usuarios se cae, trámites sigue
 * respondiendo.
 *
 * El id del trámite es un código legible: 'T' + secuencia (T1, T13, T222).
 */
export default class TramitesController {
  async store({ request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    const data = request.only([
      'usuarioId',
      'tipo',
      'tipoDetalle',
      'descripcion',
      'monto',
      'creadoClienteEn',
    ])

    // Un ciudadano solo puede crear trámites a su nombre. Si mandara otro
    // usuarioId, se ignora. Los perfiles privilegiados sí pueden indicarlo.
    const usuarioId = esPrivilegiado(identidad.rol) ? String(data.usuarioId ?? '') : identidad.id

    if (!DNI.test(usuarioId)) {
      return response.badRequest({
        message: 'El usuario indicado no es valido',
      })
    }

    // El navegador manda una clave por operación. Si el POST llegó al servidor
    // pero la respuesta se perdió, el reintento con la misma clave devuelve el
    // trámite ya creado en vez de duplicarlo. Se busca antes de llamar a
    // usuarios: así el reintento funciona incluso si usuarios está caído.
    const claveCruda = String(request.header('idempotency-key') ?? '').trim()

    if (claveCruda && !CLAVE_IDEMPOTENCIA.test(claveCruda)) {
      return response.badRequest({ message: 'La clave de idempotencia no es válida' })
    }

    const claveIdempotencia = claveCruda || null

    if (claveIdempotencia) {
      const existente = await Tramite.query()
        .where('usuario_id', usuarioId)
        .where('clave_idempotencia', claveIdempotencia)
        .first()

      if (existente) {
        response.header('Idempotent-Replay', 'true')
        return response.ok(existente)
      }
    }

    const origen = request.header('x-origen') === 'offline' ? 'offline' : 'web'

    // La fecha original la pone el cliente porque el trámite pudo quedarse en
    // la cola offline. Si no es una fecha válida (o está en el futuro) se
    // ignora: `created_at` sigue siendo la fecha fiable del servidor.
    let creadoClienteEn: DateTime | null = null
    const creadoClienteCrudo = String(data.creadoClienteEn ?? '').trim()

    if (creadoClienteCrudo) {
      const fecha = DateTime.fromISO(creadoClienteCrudo, { setZone: true })

      if (fecha.isValid && fecha.toMillis() <= DateTime.now().plus({ minutes: 5 }).toMillis()) {
        creadoClienteEn = fecha
      }
    }

    const tipo = String(data.tipo ?? '').trim()

    if (!tipo) {
      return response.badRequest({ message: 'El tipo de trámite es obligatorio' })
    }

    // El monto no se confía al cliente salvo en "Otro". Para los tipos del
    // catálogo lo impone la base de datos.
    let tipoDetalle: string | null = null
    let monto: number

    if (tipo === TIPO_OTRO) {
      tipoDetalle = String(data.tipoDetalle ?? '').trim()
      monto = Number(data.monto)

      if (!tipoDetalle) {
        return response.badRequest({ message: 'Especifica qué trámite es' })
      }

      if (!Number.isFinite(monto) || monto <= 0) {
        return response.badRequest({ message: 'El monto no es válido' })
      }
    } else {
      const catalogo = await TipoTramite.query().where('nombre', tipo).where('activo', true).first()

      if (!catalogo) {
        return response.badRequest({ message: 'El tipo de trámite no existe' })
      }

      monto = Number(catalogo.monto)
    }

    // Verificar contra el servicio usuarios que el usuario existe realmente.
    // Esta llamada hace avanzar el reloj, así que el sello se toma después.
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

    // El sello de creación se calcula una sola vez y se guarda en la fila y en
    // el primer evento del historial. Aunque luego se actualice `tramites`, ese
    // primer sello queda preservado en `tramites_eventos`.
    const sello = { lamport: tick(), nodeId: idNodo() }

    let tramite: Tramite

    try {
      tramite = await Database.transaction(async (trx) => {
        const creado = await Tramite.create(
          {
            id: await siguienteCodigo('T', 'tramites_num_seq'),
            usuarioId,
            tipo,
            tipoDetalle,
            descripcion: String(data.descripcion ?? ''),
            monto,
            // Se fija aquí para que la respuesta incluya el estado: la columna
            // tiene valor por defecto en la base, pero Lucid no relee la fila.
            estado: 'pendiente',
            version: 1,
            claveIdempotencia,
            creadoClienteEn,
            origen,
            ...sello,
          },
          { client: trx }
        )

        await TramiteEvento.create(
          {
            tramiteId: creado.id,
            estadoAnterior: null,
            estadoNuevo: creado.estado,
            actorId: identidad.id,
            lamport: sello.lamport,
            nodeId: sello.nodeId,
          },
          { client: trx }
        )

        return creado
      })
    } catch (error) {
      // Dos réplicas pueden recibir el mismo reintento a la vez. La restricción
      // única deja pasar a una; la otra devuelve el trámite que ganó.
      const codigo =
        (error as { code?: string; original?: { code?: string } })?.original?.code ??
        (error as { code?: string })?.code

      if (codigo === '23505' && claveIdempotencia) {
        const existente = await Tramite.query()
          .where('usuario_id', usuarioId)
          .where('clave_idempotencia', claveIdempotencia)
          .first()

        if (existente) {
          response.header('Idempotent-Replay', 'true')
          return response.ok(existente)
        }
      }

      throw error
    }

    response.header('X-Lamport', String(tramite.lamport))
    response.header('X-Node-Id', String(tramite.nodeId))

    return response.created(tramite)
  }

  async index({ request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    const query = Tramite.query()

    // El servicio de pagos y el reconciliador actúan en nombre del sistema, no
    // de una persona: necesitan ver cualquier trámite.
    const veTodo = esPrivilegiado(identidad.rol) || identidad.rol === ROLES.servicio

    if (!veTodo) {
      query.where('usuario_id', identidad.id)
    }

    // Los trámites que llegan desde la cola offline conservan su fecha real,
    // así que se ordenan por ella y no por el momento en que se sincronizaron.
    return response.ok(
      await query
        .orderByRaw('COALESCE(creado_cliente_en, created_at) ASC')
        .orderBy('created_at', 'asc')
    )
  }

  async show({ params, request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    const tramite = await Tramite.find(params.id)

    const veTodo = esPrivilegiado(identidad.rol) || identidad.rol === ROLES.servicio

    // Se responde 404 y no 403 para no revelar que el trámite existe.
    if (!tramite || (!veTodo && tramite.usuarioId !== identidad.id)) {
      return response.notFound({
        message: 'Trámite no encontrado',
      })
    }

    return response.ok(tramite)
  }

  /**
   * Historial de estados del trámite, en orden de reloj lógico.
   *
   * Cada evento es inmutable y lleva su propio sello (`lamport`, `node_id`),
   * así que el sello de creación no se pierde al actualizar el trámite.
   */
  async eventos({ params, request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    const tramite = await Tramite.find(params.id)

    const veTodo = esPrivilegiado(identidad.rol) || identidad.rol === ROLES.servicio

    if (!tramite || (!veTodo && tramite.usuarioId !== identidad.id)) {
      return response.notFound({
        message: 'Trámite no encontrado',
      })
    }

    const eventos = await TramiteEvento.query()
      .where('tramite_id', tramite.id)
      .orderBy('lamport', 'asc')
      .orderBy('id', 'asc')

    return response.ok(eventos)
  }

  /**
   * El PATCH lo usa el servicio de pagos para marcar el trámite como pagado y,
   * además, el administrador para corregir tipo, descripción o monto.
   */
  async update({ params, request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    const esServicio = identidad.rol === ROLES.servicio
    const esAdmin = identidad.rol === ROLES.admin

    if (!esServicio && !esPrivilegiado(identidad.rol)) {
      return response.forbidden({
        message: 'No tienes permiso para modificar un trámite',
      })
    }

    const tramite = await Tramite.find(params.id)

    if (!tramite) {
      return response.notFound({
        message: 'Trámite no encontrado',
      })
    }

    // Se recuerda el estado previo: si al final cambió, se registra el evento.
    const estadoAnterior = tramite.estado

    const data = request.only(['estado', 'tipo', 'tipoDetalle', 'descripcion', 'monto', 'version'])

    // Si el cliente envía la versión que leyó, se valida contra la actual. No es
    // obligatoria: el UPDATE condicional de más abajo ya evita pisar escrituras
    // concurrentes, pero enviarla permite detectar datos viejos de inmediato.
    const versionEsperada =
      data.version !== undefined && data.version !== null && String(data.version).trim() !== ''
        ? Number(data.version)
        : null

    if (versionEsperada !== null && (!Number.isInteger(versionEsperada) || versionEsperada < 1)) {
      return response.badRequest({ message: 'La versión no es válida' })
    }

    const tocaDatos =
      data.tipo !== undefined ||
      data.tipoDetalle !== undefined ||
      data.descripcion !== undefined ||
      data.monto !== undefined

    // Tesorería y el servicio solo cambian el estado; editar los datos es cosa
    // del administrador.
    if (tocaDatos && !esAdmin) {
      return response.forbidden({
        message: 'Solo el administrador general puede editar los datos del trámite',
      })
    }

    if (data.estado !== undefined) {
      const nuevoEstado = String(data.estado).trim()

      if (!esEstadoValido(nuevoEstado)) {
        return response.badRequest({
          message: 'El estado no es válido',
          estados: ESTADOS,
        })
      }

      if (!transicionPermitida(tramite.estado, nuevoEstado)) {
        return response.badRequest({
          message: `No se puede pasar de "${tramite.estado}" a "${nuevoEstado}"`,
        })
      }

      tramite.estado = nuevoEstado
    }

    if (data.descripcion !== undefined) {
      tramite.descripcion = String(data.descripcion)
    }

    if (data.tipo !== undefined) {
      const tipo = String(data.tipo).trim()

      if (!tipo) {
        return response.badRequest({ message: 'El tipo de trámite es obligatorio' })
      }

      if (tipo === TIPO_OTRO) {
        const detalle = String(data.tipoDetalle ?? tramite.tipoDetalle ?? '').trim()
        const monto = data.monto !== undefined ? Number(data.monto) : Number(tramite.monto)

        if (!detalle) {
          return response.badRequest({ message: 'Especifica qué trámite es' })
        }

        if (!Number.isFinite(monto) || monto <= 0) {
          return response.badRequest({ message: 'El monto no es válido' })
        }

        tramite.tipo = TIPO_OTRO
        tramite.tipoDetalle = detalle
        tramite.monto = monto
      } else {
        const catalogo = await TipoTramite.query()
          .where('nombre', tipo)
          .where('activo', true)
          .first()

        if (!catalogo) {
          return response.badRequest({ message: 'El tipo de trámite no existe' })
        }

        tramite.tipo = tipo
        tramite.tipoDetalle = null
        tramite.monto = Number(catalogo.monto)
      }
    } else if (data.monto !== undefined) {
      const monto = Number(data.monto)

      if (!Number.isFinite(monto) || monto < 0) {
        return response.badRequest({ message: 'El monto no es válido' })
      }

      tramite.monto = monto
    }

    if (versionEsperada !== null && versionEsperada !== tramite.version) {
      return response.status(409).send({
        message: 'El trámite fue modificado por otra operación',
        version: tramite.version,
      })
    }

    // Esta llamada la hace pagos al orquestar el pago, asi que su sello debe
    // entrar en el reloj de esta replica: regla L2 de Lamport.
    recibir(request.header('X-Lamport'))

    tramite.lamport = tick()
    tramite.nodeId = idNodo()

    const versionLeida = tramite.version
    const actualizadoEn = DateTime.now()

    // UPDATE condicional: solo aplica si la versión sigue siendo la que leyó
    // esta petición. Si otra escritura ganó la carrera, `filas` es 0 y se
    // responde 409 en vez de sobrescribir datos ajenos.
    const aplicado = await Database.transaction(async (trx) => {
      const filas = await Tramite.query({ client: trx })
        .where('id', tramite.id)
        .where('version', versionLeida)
        .returning('id')
        .update({
          estado: tramite.estado,
          tipo: tramite.tipo,
          tipoDetalle: tramite.tipoDetalle,
          descripcion: tramite.descripcion,
          monto: tramite.monto,
          lamport: tramite.lamport,
          nodeId: tramite.nodeId,
          version: versionLeida + 1,
          updatedAt: actualizadoEn,
        })

      if (filas.length === 0) {
        return false
      }

      if (estadoAnterior !== tramite.estado) {
        await TramiteEvento.create(
          {
            tramiteId: tramite.id,
            estadoAnterior,
            estadoNuevo: tramite.estado,
            actorId: identidad.id,
            lamport: tramite.lamport!,
            nodeId: tramite.nodeId!,
          },
          { client: trx }
        )
      }

      return true
    })

    if (!aplicado) {
      const actual = await Tramite.find(tramite.id)

      return response.status(409).send({
        message: 'El trámite fue modificado por otra operación',
        version: actual?.version ?? null,
      })
    }

    tramite.version = versionLeida + 1
    tramite.updatedAt = actualizadoEn

    response.header('X-Lamport', String(tramite.lamport))
    response.header('X-Node-Id', String(tramite.nodeId))

    return response.ok(tramite)
  }

  async destroy({ params, request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    if (identidad.rol !== ROLES.admin) {
      return response.forbidden({
        message: 'Solo el administrador general puede eliminar trámites',
      })
    }

    const tramite = await Tramite.find(params.id)

    if (!tramite) {
      return response.notFound({ message: 'Trámite no encontrado' })
    }

    await tramite.delete()

    return response.ok({ message: 'Trámite eliminado', id: tramite.id })
  }
}
