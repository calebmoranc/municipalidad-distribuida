import logger from '@adonisjs/core/services/logger'
import { reconciliar } from '#services/reconciliador'

/**
 * Al arrancar cada réplica, una pasada de reconciliación.
 *
 * Es el momento adecuado: si el proceso anterior murió a media operación, la
 * intención quedó en 'pendiente' y este es el primer instante en que hay alguien
 * que puede retomarla.
 *
 * Se ejecuta sin propagar errores: si el reconciliador falla al arrancar (por
 * ejemplo porque la base todavía no responde), el servicio debe igualmente
 * levantarse. La siguiente pasada lo recogerá.
 *
 * Nota sobre el arranque: se dispara al importar el módulo y no desde la función
 * exportada, porque el import del preload ocurre siempre, mientras que no está
 * garantizado que se invoque la función por defecto. El guardia evita que se
 * ejecute dos veces.
 */

let yaEjecutado = false

async function ejecutar() {
  if (yaEjecutado) {
    return
  }
  yaEjecutado = true

  // Pequeña espera para no competir con el arranque de Lucid ni con las demás
  // réplicas, que en este proyecto arrancan a la vez por docker compose.
  await new Promise((resolver) => setTimeout(resolver, 4000))

  try {
    const resultado = await reconciliar()
    const total = resultado.confirmados + resultado.revertidos + resultado.pendientes

    if (total > 0) {
      logger.info(
        `reconciliacion inicial: ${resultado.confirmados} confirmados, ` +
          `${resultado.revertidos} revertidos, ${resultado.pendientes} pendientes`
      )
    }
  } catch (error) {
    logger.warn(`la reconciliacion inicial no pudo ejecutarse: ${String(error).slice(0, 200)}`)
  }
}

void ejecutar()

export default ejecutar
