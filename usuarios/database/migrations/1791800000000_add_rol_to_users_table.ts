import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Rol del usuario dentro del sistema.
 *
 * Se añade ahora, cuando el sistema de autenticación todavía es pequeño, porque
 * después obliga a migrar tokens, permisos y la interfaz a la vez. El valor por
 * defecto es 'ciudadano': las filas que ya existen quedan con ese rol sin
 * necesidad de tocarlas.
 *
 *   ciudadano                 puede crear sus propios trámites y pagos
 *   personal_muni_tesoreria   ve todo y confirma/acredita pagos
 *   admin                     además ve todos los usuarios y el módulo de administración
 */
export default class extends BaseSchema {
  protected tableName = 'users'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('rol', 40).notNullable().defaultTo('ciudadano')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('rol')
    })
  }
}
