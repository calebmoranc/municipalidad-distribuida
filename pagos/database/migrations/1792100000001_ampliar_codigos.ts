import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Amplía los códigos de pago y las referencias al trámite de varchar(4) a
 * varchar(12), por el mismo motivo que en tramites (H-21): `P1`…`P999` se agota.
 *
 * SQL directo porque `id_pago` es clave primaria y el generador de esquema de
 * Lucid emite `drop not null` al alterar, que PostgreSQL rechaza en una PK.
 */
export default class extends BaseSchema {
  async up() {
    this.defer(async (db) => {
      await db.rawQuery(`ALTER TABLE pagos ALTER COLUMN id_pago TYPE varchar(12)`)
      await db.rawQuery(`ALTER TABLE pagos ALTER COLUMN id_tramite TYPE varchar(12)`)
      await db.rawQuery(`ALTER TABLE pagos_intentos ALTER COLUMN id_tramite TYPE varchar(12)`)
      await db.rawQuery(`ALTER TABLE pagos_intentos ALTER COLUMN pago_id TYPE varchar(12)`)
    })
  }

  async down() {
    this.defer(async (db) => {
      await db.rawQuery(`ALTER TABLE pagos ALTER COLUMN id_pago TYPE varchar(4)`)
      await db.rawQuery(`ALTER TABLE pagos ALTER COLUMN id_tramite TYPE varchar(4)`)
      await db.rawQuery(`ALTER TABLE pagos_intentos ALTER COLUMN id_tramite TYPE varchar(4)`)
      await db.rawQuery(`ALTER TABLE pagos_intentos ALTER COLUMN pago_id TYPE varchar(4)`)
    })
  }
}
