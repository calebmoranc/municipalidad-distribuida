import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Registra el sello del reloj logico de Lamport del evento que creo la fila.
 *
 * (lamport, node_id) permite reconstruir el orden parcial entre procesos:
 * si el lamport de una fila es menor que el de otra de otra replica, la primera
 * ocurrio antes de forma garantizada.
 *
 * Nullable porque las filas existentes no tienen sello historico.
 */
export default class extends BaseSchema {
  protected tableName = 'tramites'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.integer('lamport').nullable()
      table.string('node_id', 100).nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('lamport')
      table.dropColumn('node_id')
    })
  }
}
