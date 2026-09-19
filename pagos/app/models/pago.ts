import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class Pago extends BaseModel {
  static table = 'pagos'
  @column({ isPrimary: true })
  declare idPago: number

  @column()
  declare idTramite: number

  @column()
  declare monto: number

  @column()
  declare metodoPago: string

  @column()
  declare estado: string

  @column.dateTime()
  declare fechaPago: DateTime

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
