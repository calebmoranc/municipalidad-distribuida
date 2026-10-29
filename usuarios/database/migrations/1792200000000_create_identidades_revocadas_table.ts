import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Lista de identidades firmadas revocadas antes de su caducidad.
 *
 * La identidad es stateless (HMAC), así que no hay sesión que borrar. Para poder
 * invalidarla antes del TTL se guarda su `jti` hasta que el token caduque. Los
 * servicios de dominio consultan esta lista y la cachean unos segundos.
 */
export default class extends BaseSchema {
  protected tableName = 'identidades_revocadas'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('jti', 36).primary()
      table.timestamp('exp').notNullable()
      table.timestamp('created_at').notNullable()
      table.index(['exp'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
