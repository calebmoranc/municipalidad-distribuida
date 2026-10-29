import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Un cambio de estado del trámite, con el sello del reloj lógico del evento.
 *
 * Es inmutable: los eventos no se editan ni se borran (salvo en cascada cuando
 * se elimina el trámite). Así el sello de creación nunca se sobrescribe.
 */
export default class TramiteEvento extends BaseModel {
  static table = 'tramites_eventos'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare tramiteId: string

  @column()
  declare estadoAnterior: string | null

  @column()
  declare estadoNuevo: string

  @column()
  declare actorId: string | null

  @column()
  declare lamport: number

  @column()
  declare nodeId: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
