import User from '#models/user'
import { BaseSeeder } from '@adonisjs/lucid/seeders'

/**
 * Crea las cuentas de demostración del sistema.
 *
 * Es idempotente a propósito: `docker compose up` vuelve a ejecutar los seeders
 * cada vez que cambia la imagen, y este no debe fallar ni duplicar cuentas.
 *
 * Las credenciales están aquí porque es un entorno de demostración. En un
 * despliegue real llegarían por variables de entorno y no se versionarían.
 */
const CUENTAS = [
  {
    id: '10000001',
    email: 'admin@municipalidad.gob',
    password: 'Municipal123',
    fullName: 'Administrador general',
    rol: 'admin',
  },
  {
    id: '10000002',
    email: 'tesoreria@municipalidad.gob',
    password: 'Tesoreria123',
    fullName: 'Tesorería municipal',
    rol: 'personal_muni_tesoreria',
  },
]

export default class extends BaseSeeder {
  async run() {
    for (const cuenta of CUENTAS) {
      const existente = await User.findBy('email', cuenta.email)

      if (existente) {
        // Si la cuenta ya existía con otro rol (por ejemplo, creada a mano
        // antes de existir el rol), se corrige.
        if (existente.rol !== cuenta.rol) {
          existente.rol = cuenta.rol
          await existente.save()
        }
        continue
      }

      await User.create(cuenta)
    }
  }
}
