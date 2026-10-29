import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Agrega la referencia al usuario que realiza el pago.
 *
 * La columna queda nullable a proposito: la tabla ya tiene filas y no hay forma
 * de saber de que usuario eran. Si se declarara notNullable habria que borrarlas
 * o inventar un usuario. La obligatoriedad se aplica en la capa de aplicacion
 * (el controlador rechaza el pago si no viene usuarioId).
 *
 * Es el DNI (varchar(8)), igual que users.id. No puede haber foreign key a
 * users.id porque esa tabla vive en usuarios_db: las bases son separadas.
 */
export default class extends BaseSchema {
  protected tableName = 'pagos'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('usuario_id', 8).nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('usuario_id')
    })
  }
}
