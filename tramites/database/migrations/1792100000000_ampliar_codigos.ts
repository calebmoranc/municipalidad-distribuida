import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Amplía los códigos de trámite de varchar(4) a varchar(12).
 *
 * Con 4 caracteres el espacio `T1`…`T999` se agota (H-21). La secuencia sigue
 * generando el número sin ceros a la izquierda, y `T` + 11 dígitos entra de
 * sobra en 12 caracteres.
 *
 * Se usa SQL directo porque `id` es clave primaria y el generador de esquema de
 * Lucid emite `drop not null` al alterar, que PostgreSQL rechaza en una PK.
 * El FK de `tramites_eventos` se quita antes de cambiar el tipo y se vuelve a
 * crear después.
 */
export default class extends BaseSchema {
  async up() {
    this.defer(async (db) => {
      await db.rawQuery(
        `ALTER TABLE tramites_eventos DROP CONSTRAINT IF EXISTS tramites_eventos_tramite_id_foreign`
      )
      await db.rawQuery(`ALTER TABLE tramites ALTER COLUMN id TYPE varchar(12)`)
      await db.rawQuery(`ALTER TABLE tramites_eventos ALTER COLUMN tramite_id TYPE varchar(12)`)
      await db.rawQuery(
        `ALTER TABLE tramites_eventos ADD CONSTRAINT tramites_eventos_tramite_id_foreign
           FOREIGN KEY (tramite_id) REFERENCES tramites(id) ON DELETE CASCADE`
      )
    })
  }

  async down() {
    this.defer(async (db) => {
      await db.rawQuery(
        `ALTER TABLE tramites_eventos DROP CONSTRAINT IF EXISTS tramites_eventos_tramite_id_foreign`
      )
      await db.rawQuery(`ALTER TABLE tramites ALTER COLUMN id TYPE varchar(4)`)
      await db.rawQuery(`ALTER TABLE tramites_eventos ALTER COLUMN tramite_id TYPE varchar(4)`)
      await db.rawQuery(
        `ALTER TABLE tramites_eventos ADD CONSTRAINT tramites_eventos_tramite_id_foreign
           FOREIGN KEY (tramite_id) REFERENCES tramites(id) ON DELETE CASCADE`
      )
    })
  }
}
