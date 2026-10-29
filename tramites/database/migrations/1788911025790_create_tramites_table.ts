import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tramites'

  async up() {
    // Secuencia que da el número del código. Vive en la base, no en el proceso,
    // así que las dos réplicas no pueden repetir un id aunque creen a la vez.
    this.defer(async (db) => {
      await db.rawQuery(`CREATE SEQUENCE IF NOT EXISTS tramites_num_seq START WITH 1`)
    })

    this.schema.createTable(this.tableName, (table) => {
      // Código legible: 'T' seguido del número de la secuencia. No se rellenan
      // ceros: T1, T13, T222. La migración 1792100… lo amplió a varchar(12).
      table.string('id', 4).primary()

      // DNI del ciudadano, igual que users.id en el servicio de usuarios. No
      // hay foreign key: las bases están separadas por diseño.
      table.string('usuario_id', 8).notNullable()

      table.string('tipo', 100).notNullable()

      // Solo para el tipo "Otro": describe qué trámite es en realidad.
      table.string('tipo_detalle', 200).nullable()

      table.text('descripcion').notNullable()

      // Monto que se cobrará. En los tipos fijos lo impone el catálogo; en
      // "Otro" lo indica quien crea el trámite.
      table.decimal('monto', 10, 2).notNullable().defaultTo(0)

      table.string('estado', 30).notNullable().defaultTo('pendiente')

      table.timestamp('created_at')
      table.timestamp('updated_at')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
    this.defer(async (db) => {
      await db.rawQuery(`DROP SEQUENCE IF EXISTS tramites_num_seq`)
    })
  }
}
