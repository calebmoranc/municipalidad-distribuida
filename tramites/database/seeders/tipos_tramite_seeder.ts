import TipoTramite from '#models/tipo_tramite'
import { BaseSeeder } from '@adonisjs/lucid/seeders'

/**
 * Catálogo inicial de tipos de trámite con sus montos.
 *
 * Es idempotente: `docker compose up` vuelve a ejecutar los seeders cuando
 * cambia la imagen, y este no debe duplicar entradas ni sobrescribir los montos
 * que el administrador haya ajustado.
 */
const TIPOS = [
  { nombre: 'Licencia de funcionamiento', monto: 25000 },
  { nombre: 'Permiso de construcción', monto: 40000 },
  { nombre: 'Certificado de residencia', monto: 3000 },
  { nombre: 'Reclamo ciudadano', monto: 1000 },
]

export default class extends BaseSeeder {
  async run() {
    for (const tipo of TIPOS) {
      const existente = await TipoTramite.findBy('nombre', tipo.nombre)

      if (existente) continue

      await TipoTramite.create(tipo)
    }
  }
}
