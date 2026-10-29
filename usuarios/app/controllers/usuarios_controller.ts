import User from '#models/user'
import { enviar, recibir } from '#services/reloj_logico'
import { leerIdentidad } from '#services/identidad'
import { listarRevocadas, revocar as revocarIdentidad } from '#services/revocaciones'
import { crearUsuarioValidator } from '#validators/user'
import UserTransformer from '#transformers/user_transformer'
import type { HttpContext } from '@adonisjs/core/http'

export default class UsuariosController {
  async index({ request, response }: HttpContext) {
    // Solo el administrador general puede ver la lista completa de cuentas.
    // El registro público y la consulta por id siguen abiertos: la segunda la
    // usan trámites y pagos para validar que un usuario existe.
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    if (identidad.rol !== 'admin') {
      return response.forbidden({
        message: 'Solo el administrador general puede listar los usuarios',
      })
    }

    // Este servicio solo responde consultas, no produce eventos de negocio, pero
    // su reloj tambien avanza: recibe el sello de quien pregunta (regla L2) y
    // devuelve el suyo, que es un evento de envio.
    recibir(request.header('X-Lamport'))
    response.header('X-Lamport', String(enviar().lamport))

    return User.all() //lista los usuarios
  }

  async show({ params, request, response }: HttpContext) {
    recibir(request.header('X-Lamport'))
    response.header('X-Lamport', String(enviar().lamport))

    return User.findOrFail(params.id) //obtiene uno por ID o devuelve error 404.
  }

  /**
   * Lista de `jti` revocados y aún no caducados. La consultan trámites y pagos
   * para mantener su caché local. Solo administración o una identidad de
   * servicio pueden leerla.
   */
  async revocadas({ request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    if (identidad.rol !== 'admin' && identidad.rol !== 'servicio') {
      return response.forbidden({
        message: 'Solo administración o un servicio pueden consultar las revocaciones',
      })
    }

    return { jtis: await listarRevocadas() }
  }

  /**
   * Revoca una identidad concreta por su `jti` antes de que caduque. El logout
   * cubre el caso normal; este endpoint permite a administración invalidar una
   * identidad copiada o perdida.
   */
  async revocar({ request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    if (identidad.rol !== 'admin') {
      return response.forbidden({
        message: 'Solo el administrador general puede revocar identidades',
      })
    }

    const jti = String(request.input('jti') ?? '').trim()

    if (jti.length < 8 || jti.length > 36) {
      return response.badRequest({ message: 'El jti no es válido' })
    }

    const expPedido = Number(request.input('exp'))
    const exp =
      Number.isFinite(expPedido) && expPedido > 0
        ? expPedido
        : Math.floor(Date.now() / 1000) + 12 * 60 * 60

    await revocarIdentidad(jti, exp)

    return { message: 'Identidad revocada', jti }
  }

  /**
   * Crear una cuenta desde administración. Sirve para dar de alta a una persona
   * que llega a la oficina sin perfil y, sobre todo, para crear perfiles de
   * trabajadores: aquí sí se elige el rol. El acceso lo limita el middleware de
   * identidad: solo el administrador general llega hasta aquí.
   */
  async store({ request, response }: HttpContext) {
    const identidad = leerIdentidad(request)

    if (!identidad) {
      return response.unauthorized({ message: 'Falta la identidad del usuario' })
    }

    if (identidad.rol !== 'admin') {
      return response.forbidden({
        message: 'Solo el administrador general puede crear cuentas',
      })
    }

    const { dni, fullName, email, password, rol } =
      await request.validateUsing(crearUsuarioValidator)

    const user = await User.create({ id: dni, fullName, email, password, rol })

    return response.created(UserTransformer.transform(user))
  }
}
//La contraseña no se incluirá porque el modelo tiene serializeAs: null.
