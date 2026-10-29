import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * El rol `personal_muni_tesoreria` no cabe en varchar(20), que es el tamaño con
 * el que se creó la columna originalmente.
 *
 * Esta migración la amplía a 40 para que los nombres de rol sean descriptivos
 * sin tener que abreviarlos. La migración original también se actualizó para
 * instalaciones nuevas, pero las bases ya migradas necesitan este ALTER.
 */
export default class extends BaseSchema {
  protected tableName = 'users'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('rol', 40).notNullable().defaultTo('ciudadano').alter()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('rol', 20).notNullable().defaultTo('ciudadano').alter()
    })
  }
}
