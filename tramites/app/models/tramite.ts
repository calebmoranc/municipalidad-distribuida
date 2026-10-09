import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class Tramite extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare usuarioId: number

  @column()
  declare tipo: string

  @column()
  declare descripcion: string

  @column()
  declare estado: string

  /** Sello del reloj logico de Lamport del evento que creo la fila. */
  @column()
  declare lamport: number | null

  /** Replica que ejecuto el evento. */
  @column()
  declare nodeId: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}