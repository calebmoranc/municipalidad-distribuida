import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Intención de registrar un pago, persistida antes de hacer nada.
 *
 * Es lo que permite retomar una operación interrumpida. Ver
 * `app/services/reconciliador.ts`.
 */
export default class PagoIntento extends BaseModel {
  static table = 'pagos_intentos'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare idTramite: string

  @column()
  declare usuarioId: string

  @column()
  declare pagoId: string | null

  /** 'pendiente' | 'confirmado' | 'revertido' */
  @column()
  declare estado: string

  @column()
  declare intentos: number

  @column()
  declare ultimoError: string | null

  @column()
  declare lamport: number | null

  @column()
  declare nodeId: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updatedAt: DateTime
}
