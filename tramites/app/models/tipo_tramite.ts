import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Tipo de trámite del catálogo, con su monto fijo.
 *
 * El tipo "Otro" no se guarda aquí: quien crea el trámite escribe la
 * descripción y el monto libremente.
 */
export default class TipoTramite extends BaseModel {
  static table = 'tipos_tramite'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare nombre: string

  @column()
  declare monto: number

  @column()
  declare activo: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
