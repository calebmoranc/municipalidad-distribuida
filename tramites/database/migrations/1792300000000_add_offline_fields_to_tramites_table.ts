import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Campos para la cola offline de la interfaz.
 *
 * `clave_idempotencia` evita duplicar un trámite cuando el navegador reintenta
 * un POST cuya respuesta se perdió. La clave es única por usuario, no global:
 * dos ciudadanos pueden generar el mismo UUID por casualidad sin chocar.
 *
 * `creado_cliente_en` conserva la fecha en que el ciudadano completó el
 * trámite, aunque el envío se haya hecho más tarde. `created_at` sigue siendo
 * la fecha de registro en el servidor, que es la que vale para auditoría.
 *
 * `origen` distingue si llegó directo desde la web o desde la cola offline.
 */
export default class extends BaseSchema {
  protected tableName = 'tramites'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('clave_idempotencia', 64).nullable()
      table.timestamp('creado_cliente_en').nullable()
      table.string('origen', 20).notNullable().defaultTo('web')

      table.unique(['usuario_id', 'clave_idempotencia'], 'tramites_usuario_idempotencia_unique')
      table.index(['creado_cliente_en'], 'tramites_creado_cliente_en_idx')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropUnique(['usuario_id', 'clave_idempotencia'], 'tramites_usuario_idempotencia_unique')
      table.dropIndex(['creado_cliente_en'], 'tramites_creado_cliente_en_idx')
      table.dropColumn('clave_idempotencia')
      table.dropColumn('creado_cliente_en')
      table.dropColumn('origen')
    })
  }
}
