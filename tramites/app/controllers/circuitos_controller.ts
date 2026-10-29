import { circuitoUsuarios } from '#services/usuarios_client'
import { metricas } from '#services/cliente_http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Estado del interruptor de circuito de este servicio, para poder observar la
 * tolerancia a fallos con curl:
 *
 *   GET /api/v1/circuitos
 *
 * Es una lectura: no cuenta como evento ni avanza el reloj.
 */
export default class CircuitosController {
  async show({ response }: HttpContext) {
    return response.ok({
      circuitos: [circuitoUsuarios.foto()],
      metricas: [metricas('usuarios')],
    })
  }
}
