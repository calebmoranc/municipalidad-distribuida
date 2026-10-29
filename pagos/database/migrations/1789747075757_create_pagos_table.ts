import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'pagos'

  async up() {
    // Secuencia del número del pago. Es de la base, así que las dos réplicas de
    // pagos no pueden repetir código.
    this.defer(async (db) => {
      await db.rawQuery(`CREATE SEQUENCE IF NOT EXISTS pagos_num_seq START WITH 1`)
    })

    this.schema.createTable(this.tableName, (table) => {
      // Código legible: P1, P13, P333. La migración 1792100… lo amplió a varchar(12).
      table.string('id_pago', 4).primary()

      // Código del trámite (T1, T13...). Vive en otra base: sin foreign key.
      table.string('id_tramite', 4).notNullable()

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
    this.defer(async (db) => {
      await db.rawQuery(`DROP SEQUENCE IF EXISTS pagos_num_seq`)
    })
  }
}
