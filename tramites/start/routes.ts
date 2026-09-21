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
import TramitesController from '#controllers/tramites_controller'

router.get('/', () => {
  return { hello: 'world' }
})

router
  .group(() => {
    router
      .post('/tramites', [TramitesController, 'store'])
      .as('tramites.store')

    router
      .get('/tramites', [TramitesController, 'index'])
      .as('tramites.index')

    router
      .get('/tramites/:id', [TramitesController, 'show'])
      .as('tramites.show')

    router
      .patch('/tramites/:id', [TramitesController, 'update'])
      .as('tramites.update')

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