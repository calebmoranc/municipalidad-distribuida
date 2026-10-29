import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'users'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      // El identificador del usuario es su DNI: ocho dígitos, sin ceros de
      // relleno obligatorios. Se usa varchar y no integer para conservar los
      // ceros a la izquierda y porque en trámites y pagos viaja como texto.
      table.string('id', 8).primary()

      table.string('full_name').nullable()
      table.string('email', 254).notNullable().unique()
      table.string('password').notNullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
