import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class Tramite extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  /** DNI del ciudadano dueño del trámite. */
  @column()
  declare usuarioId: string

  @column()
  declare tipo: string

  /** Descripción libre del trámite cuando el tipo es "Otro". */
  @column()
  declare tipoDetalle: string | null

  @column()
  declare descripcion: string

  /** Monto a cobrar: del catálogo si el tipo es fijo, indicado si es "Otro". */
  @column()
  declare monto: number

  @column()
  declare estado: string

  /** Sello del reloj logico de Lamport del evento que creo la fila. */
  @column()
  declare lamport: number | null

  /** Replica que ejecuto el evento. */
  @column()
  declare nodeId: string | null

  /** Versión para control de concurrencia optimista (empieza en 1). */
  @column()
  declare version: number

  /** Clave del navegador para que un reintento no cree un duplicado. */
  @column()
  declare claveIdempotencia: string | null

  /** Fecha en que el ciudadano completó el trámite (puede ser anterior al envío). */
  @column.dateTime()
  declare creadoClienteEn: DateTime | null

  /** `web` si se envió directo; `offline` si vino de la cola del navegador. */
  @column()
  declare origen: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
