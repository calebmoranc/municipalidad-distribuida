import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'pagos'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id_pago')

      table.integer('id_tramite').notNullable()

      table.decimal('monto', 10, 2).notNullable()

      table.string('metodo_pago').notNullable()

      table.timestamp('fecha_pago').notNullable()

      table.string('estado').notNullable().defaultTo('pendiente')

      table.timestamp('created_at')
      table.timestamp('updated_at')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
