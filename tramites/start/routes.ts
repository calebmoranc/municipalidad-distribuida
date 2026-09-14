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
router.post('/tramites', [TramitesController, 'store'])
router.get('/tramites', [TramitesController, 'index'])
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
    
    router.get('/tramites/:id', [TramitesController, 'show'])
  })
  .prefix('/api/v1')
