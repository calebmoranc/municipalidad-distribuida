import User from '#models/user'
import { loginValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import UserTransformer from '#transformers/user_transformer'
import { crearIdentidad, datosDe } from '#services/identidad'
import { revocar } from '#services/revocaciones'

export default class AccessTokensController {
  async store({ request, serialize }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)

    const user = await User.verifyCredentials(email, password)
    const token = await User.accessTokens.create(user)
    const identidad = crearIdentidad({ id: user.id, rol: user.rol })

    return serialize({
      user: UserTransformer.transform(user),
      token: token.value!.release(),
      // Identidad firmada de corta duración para trámites y pagos. El token
      // opaco de arriba es el que se revoca en el logout y usa /account/*.
      identidad,
      identidadJti: datosDe(identidad)?.jti,
    })
  }

  async destroy({ auth, request }: HttpContext) {
    const user = auth.getUserOrFail()

    if (user.currentAccessToken) {
      await User.accessTokens.delete(user, user.currentAccessToken.identifier)
    }

    // Además del token opaco, invalidar la identidad firmada que el cliente
    // estaba usando. Sin esto seguiría sirviendo para trámites y pagos hasta
    // que caducara (12 h).
    const cruda = datosDe(request.header('X-Identidad'))

    if (cruda?.jti && cruda.sub === user.id && typeof cruda.exp === 'number') {
      await revocar(cruda.jti, cruda.exp)
    }

    return {
      message: 'Logged out successfully',
    }
  }
}
