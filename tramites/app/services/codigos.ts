import db from '@adonisjs/lucid/services/db'

/**
 * Genera el siguiente código legible de un recurso (T1, T13, P1, ...).
 *
 * El número sale de una secuencia de PostgreSQL, no de un contador en memoria,
 * así que las dos réplicas de un servicio nunca repiten código. `prefijo` y
 * `secuencia` son constantes del código, nunca datos del cliente.
 */
export async function siguienteCodigo(prefijo: string, secuencia: string): Promise<string> {
  const resultado = await db.rawQuery(`SELECT '${prefijo}' || nextval('${secuencia}') AS codigo`)

  return String(resultado.rows[0].codigo)
}
