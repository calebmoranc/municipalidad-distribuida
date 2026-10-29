import db from '@adonisjs/lucid/services/db'
import PagoIntento from '#models/pago_intento'
import { reconciliar } from '#services/reconciliador'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Estado de las intenciones de pago, para poder observar la recuperación con curl:
 *
 *   GET  /api/v1/intentos          -> historial y cuántos hay en cada estado
 *   POST /api/v1/intentos/reconciliar -> fuerza una pasada del reconciliador
 *
 * Es una lectura o una orden explícita: no cuenta como evento de negocio ni
 * avanza el reloj lógico.
 */
export default class IntentosController {
  async index({ response }: HttpContext) {
    // Consulta cruda a propósito: con el query builder el tipo de la fila de un
    // count agrupado no se infiere bien, y aquí lo que interesa es solo el dato.
    const resumen = await db.rawQuery(
      'SELECT estado, count(*) AS total FROM pagos_intentos GROUP BY estado'
    )

    const porEstado: Record<string, number> = {}
    for (const fila of resumen.rows) {
      porEstado[fila.estado] = Number(fila.total)
    }

    const ultimos = await PagoIntento.query().orderBy('id', 'desc').limit(20)

    return response.ok({ porEstado, ultimos })
  }

  async reconciliar({ response }: HttpContext) {
    const resultado = await reconciliar()

    return response.ok(resultado)
  }
}
