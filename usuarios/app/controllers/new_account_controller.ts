import User from '#models/user'
import { signupValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import UserTransformer from '#transformers/user_transformer'
import { crearIdentidad, datosDe } from '#services/identidad'

export default class NewAccountController {
  async store({ request, serialize }: HttpContext) {
    const { dni, fullName, email, password } = await request.validateUsing(signupValidator)

    // El DNI que llega es el identificador de la cuenta. El rol se fija aquí, no
    // se acepta del cliente: si viniera en el cuerpo, cualquiera podría
    // registrarse como administrador.
    const user = await User.create({ id: dni, fullName, email, password, rol: 'ciudadano' })
    const token = await User.accessTokens.create(user)
    const identidad = crearIdentidad({ id: user.id, rol: user.rol })

    return serialize({
      user: UserTransformer.transform(user),
      token: token.value!.release(),
      identidad,
      identidadJti: datosDe(identidad)?.jti,
    })
  }
}
