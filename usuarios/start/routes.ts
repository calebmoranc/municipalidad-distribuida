/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'
import { controllers } from '#generated/controllers'
const UsuariosController = () => import('#controllers/usuarios_controller')
const RelojController = () => import('#controllers/reloj_controller')
router.get('/', () => {
  return { hello: 'world' }
})

router
  .group(() => {
    router
      .group(() => {
        router.post('signup', [controllers.NewAccount, 'store'])
        router.post('login', [controllers.AccessTokens, 'store'])
        router.post('revocar', [UsuariosController, 'revocar'])
      })
      .prefix('auth')
      .as('auth')

    router
      .group(() => {
        router.get('profile', [controllers.Profile, 'show'])
        router.post('logout', [controllers.AccessTokens, 'destroy'])
      })
      .prefix('account')
      .as('profile')
      .use(middleware.auth())
    router.post('usuarios', [controllers.NewAccount, 'store'])
    // Lista de identidades revocadas: la consultan trámites y pagos.
    router.get('identidades/revocadas', [UsuariosController, 'revocadas'])
    router.get('usuarios', [UsuariosController, 'index'])
    router.get('usuarios/:id', [UsuariosController, 'show'])
    // Creación desde administración: acepta rol y exige identidad de admin.
    router.post('admin/usuarios', [UsuariosController, 'store'])
    router.get('reloj', [RelojController, 'show'])
  })
  .prefix('/api/v1')
