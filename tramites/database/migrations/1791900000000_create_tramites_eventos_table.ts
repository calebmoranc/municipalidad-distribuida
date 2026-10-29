import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Historial de cambios de estado de un trámite.
 *
 * Existe porque el sello del reloj lógico (`lamport`, `node_id`) de la fila
 * `tramites` se sobrescribe en cada actualización: el de la creación se perdía.
 * Cada evento guarda su propio sello y, al ser inmutable, el sello de creación
 * queda preservado para siempre.
 *
 * `estado_anterior` es null solo en el evento de creación. `actor_id` es el DNI
 * de quien provocó el cambio, o `servicio` cuando lo hizo pagos/reconciliador.
 */
export default class extends BaseSchema {
  protected tableName = 'tramites_eventos'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      // FK dentro del mismo servicio (misma base): al borrar el trámite se borra
      // su historial. No cruza servicios, así que no rompe la separación.
      table
        .string('tramite_id', 4)
        .notNullable()
        .references('id')
        .inTable('tramites')
        .onDelete('CASCADE')

      table.string('estado_anterior', 30).nullable()
      table.string('estado_nuevo', 30).notNullable()
      table.string('actor_id', 20).nullable()

      table.integer('lamport').notNullable()
      table.string('node_id', 100).notNullable()

      table.timestamp('created_at').notNullable()

      table.index(['tramite_id', 'lamport'], 'tramites_eventos_tramite_lamport_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
