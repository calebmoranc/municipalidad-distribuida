/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/import router from '@adonisjs/core/services/router'
import PagosController from '#controllers/pagos_controller'
import { middleware } from '#start/kernel'
import { controllers } from '#generated/controllers'

router.get('/api/v1/pagos', [PagosController, 'index'])
router.post('/api/v1/pagos', [PagosController, 'store'])
router.get('/', () => {
  return { hello: 'world' }
})

router
  .group(() => {
    router
      .group(() => {
        router.post('signup', [controllers.NewAccount, 'store'])
        router.post('login', [controllers.AccessTokens, 'store'])
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
  
  })
  .prefix('/api/v1')