import { circuitoTramites } from '#services/tramites_client'
import { metricas } from '#services/cliente_http'
import { circuitoUsuarios } from '#services/usuarios_client'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Estado de los interruptores de circuito de este servicio, para poder observar
 * la tolerancia a fallos con curl:
 *
 *   GET /api/v1/circuitos
 *
 *   {"circuitos":[
 *      {"dependencia":"tramites","estado":"cerrado","fallosConsecutivos":0,...}
 *   ],
 *    "metricas":[
 *      {"dependencia":"tramites","llamadas":12,"exitos":12,"fallos":0,...}
 *   ]}
 *
 * Es una lectura: no cuenta como evento ni avanza el reloj.
 */
export default class CircuitosController {
  async show({ response }: HttpContext) {
    return response.ok({
      circuitos: [circuitoTramites.foto(), circuitoUsuarios.foto()],
      metricas: [metricas('tramites'), metricas('usuarios')],
    })
  }
}
