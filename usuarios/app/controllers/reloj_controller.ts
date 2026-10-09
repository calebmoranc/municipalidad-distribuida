import { estado } from '#services/reloj_logico'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Expone el reloj logico de esta replica para poder observar y comparar el orden
 * de los eventos entre procesos con curl.
 *
 *   GET /api/v1/reloj  ->  {"nodeId":"tramites_1","lamport":7}
 *
 * No avanza el reloj: es una lectura, no un evento.
 */
export default class RelojController {
  async show({ response }: HttpContext) {
    return response.ok(estado())
  }
}
