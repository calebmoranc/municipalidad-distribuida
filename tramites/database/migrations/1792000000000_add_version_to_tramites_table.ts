import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Versión para control de concurrencia optimista.
 *
 * Cada actualización incrementa `version`. Una escritura solo se aplica si la
 * versión que leyó sigue siendo la actual (`UPDATE ... WHERE id AND version`),
 * así dos peticiones simultáneas no se pisan. Si el cliente envía la versión que
 * vio, además se detecta que trabajaba sobre datos viejos y se responde 409.
 */
export default class extends BaseSchema {
  protected tableName = 'tramites'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.integer('version').notNullable().defaultTo(1)
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('version')
    })
  }
}
