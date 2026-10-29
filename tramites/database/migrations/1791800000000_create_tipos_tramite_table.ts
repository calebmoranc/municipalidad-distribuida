import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Catálogo de tipos de trámite y su monto fijo.
 *
 * Solo el administrador puede crear, modificar o eliminar entradas de este
 * catálogo; el resto de usuarios se limita a elegir entre los tipos existentes.
 * El tipo especial "Otro" no vive aquí: en ese caso quien crea el trámite
 * escribe su descripción y su monto.
 */
export default class extends BaseSchema {
  protected tableName = 'tipos_tramite'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table.string('nombre', 100).notNullable().unique()

      table.decimal('monto', 10, 2).notNullable()

      // Permite retirar un tipo sin borrar su historial: deja de ofrecerse.
      table.boolean('activo').notNullable().defaultTo(true)

      table.timestamp('created_at')
      table.timestamp('updated_at')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
