import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Registro de las operaciones de pago, para poder retomarlas si el proceso muere.
 *
 * El problema que resuelve: la confirmación de un pago escribe en `pagos_db` Y
 * hace que otro servicio escriba en su propia base. Son dos recursos distintos y
 * no hay transacción que los abarque. Si el proceso muere entre medias, sin esta
 * tabla el sistema queda con un pago guardado cuyo trámite nunca se marcó como
 * pagado, y nadie se acuerda de arreglarlo.
 *
 * Con esta tabla, la intención se persiste ANTES de hacer nada. Si el proceso
 * muere, la fila queda en 'pendiente' y el reconciliador la retoma al arrancar.
 *
 * No da atomicidad entre servicios: da trazabilidad y recuperación.
 */
export default class extends BaseSchema {
  protected tableName = 'pagos_intentos'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      // Códigos de trámite y pago, en texto. Sin foreign keys: viven en otras bases.
      table.string('id_tramite', 4).notNullable()
      table.string('usuario_id', 8).notNullable()

      // El pago creado. Nulo mientras la operación no ha llegado a crearlo.
      table.string('pago_id', 4).nullable()

      /**
       * Estado de la operación:
       *   pendiente   se registró la intención, todavía no terminó
       *   confirmado  el pago existe y el trámite quedó en 'pagado'
       *   revertido   no se pudo completar; el pago se borró y no pasó nada
       */
      table.string('estado', 20).notNullable().defaultTo('pendiente')

      // Cuántas veces ha intentado el reconciliador completar esta intención.
      table.integer('intentos').notNullable().defaultTo(0)

      // Por qué falló el último intento. Sirve para diagnosticar, no se muestra.
      table.string('ultimo_error', 500).nullable()

      // Sello del reloj lógico, igual que en tramites y pagos.
      table.integer('lamport').nullable()
      table.string('node_id', 100).nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()

      // El reconciliador busca sobre todo las 'pendiente'.
      table.index(['estado'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
