import UserTransformer from '#transformers/user_transformer'
import { crearIdentidad, datosDe } from '#services/identidad'
import type { HttpContext } from '@adonisjs/core/http'

export default class ProfileController {
  async show({ auth, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const identidad = crearIdentidad({ id: user.id, rol: user.rol })

    return serialize({
      user: UserTransformer.transform(user),
      // Se renueva en cada carga de la interfaz: así una sesión larga no se
      // queda con una identidad caducada.
      identidad,
      identidadJti: datosDe(identidad)?.jti,
    })
  }
}
