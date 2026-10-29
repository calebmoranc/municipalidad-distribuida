/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/
import router from '@adonisjs/core/services/router'
const TramitesController = () => import('#controllers/tramites_controller')
const TiposTramiteController = () => import('#controllers/tipos_tramite_controller')

const RelojController = () => import('#controllers/reloj_controller')
const CircuitosController = () => import('#controllers/circuitos_controller')

router.get('/', () => {
  return { hello: 'world' }
})

router
  .group(() => {
    router.post('/tramites', [TramitesController, 'store']).as('tramites.store')

    router.get('/tramites', [TramitesController, 'index']).as('tramites.index')

    router.get('/tramites/:id/eventos', [TramitesController, 'eventos']).as('tramites.eventos')

    router.get('/tramites/:id', [TramitesController, 'show']).as('tramites.show')

    router.patch('/tramites/:id', [TramitesController, 'update']).as('tramites.update')

    router.delete('/tramites/:id', [TramitesController, 'destroy']).as('tramites.destroy')

    // Catálogo de tipos y montos. Las escrituras las limita el controlador al admin.
    router.get('/tipos-tramite', [TiposTramiteController, 'index']).as('tipos.index')
    router.post('/tipos-tramite', [TiposTramiteController, 'store']).as('tipos.store')
    router.patch('/tipos-tramite/:id', [TiposTramiteController, 'update']).as('tipos.update')
    router.delete('/tipos-tramite/:id', [TiposTramiteController, 'destroy']).as('tipos.destroy')

    router.get('/reloj', [RelojController, 'show']).as('reloj.show')

    router.get('/circuitos', [CircuitosController, 'show']).as('circuitos.show')
  })
  .prefix('/api/v1')
