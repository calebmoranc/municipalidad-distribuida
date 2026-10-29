import type { ApplicationService } from '@adonisjs/core/types'
import { cargarRevocadas } from '#services/revocaciones'

/**
 * Carga la lista de identidades revocadas al arrancar. Si la tabla todavía no
 * existe (por ejemplo en el arranque previo a las migraciones) se ignora: la
 * primera verificación volverá a intentarlo de forma perezosa.
 */
export default class RevocacionesProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    if (this.app.getEnvironment() === 'test') return

    try {
      await cargarRevocadas()
    } catch {
      // La migración aún no corrió; `estaRevocada` reintenta luego.
    }
  }
}
