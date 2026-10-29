/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/ import router from '@adonisjs/core/services/router'
const PagosController = () => import('#controllers/pagos_controller')

const RelojController = () => import('#controllers/reloj_controller')
const CircuitosController = () => import('#controllers/circuitos_controller')
const IntentosController = () => import('#controllers/intentos_controller')

router.get('/api/v1/pagos', [PagosController, 'index'])
router.post('/api/v1/pagos', [PagosController, 'store'])
router.post('/api/v1/pagos/:id/confirmar', [PagosController, 'confirmar'])
router.get('/api/v1/reloj', [RelojController, 'show'])
router.get('/api/v1/circuitos', [CircuitosController, 'show'])
router.get('/api/v1/intentos', [IntentosController, 'index'])
router.post('/api/v1/intentos/reconciliar', [IntentosController, 'reconciliar'])
router.get('/', () => {
  return { hello: 'world' }
})
