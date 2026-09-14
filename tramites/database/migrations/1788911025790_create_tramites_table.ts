import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tramites'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table.integer('usuario_id').unsigned().notNullable()

      table.string('tipo', 100).notNullable()

      table.text('descripcion').notNullable()

      table.string('estado', 30).notNullable().defaultTo('pendiente')

      table.timestamp('created_at')
      table.timestamp('updated_at')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}