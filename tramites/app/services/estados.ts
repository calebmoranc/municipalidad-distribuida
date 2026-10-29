/**
 * Catálogo de estados de un trámite y transiciones permitidas.
 *
 * El estado inicial lo fija el controlador al crear (`pendiente`). A partir de
 * ahí, cada cambio debe pasar por `transicionPermitida`, de modo que un `PATCH`
 * con cualquier texto arbitrario deja de ser aceptado.
 *
 *   pendiente ──► en_revision ──► pagado
 *        │             │            │
 *        ├─────────────┼────────────┘
 *        ▼             ▼
 *    rechazado ──► pendiente / en_revision
 *        │
 *        ▼
 *     anulado  (terminal)
 *
 * Repetir el estado actual es válido y no hace nada: así la confirmación del
 * pago puede reintentarse sin fallar (los servicios son idempotentes).
 */
export const ESTADOS = ['pendiente', 'en_revision', 'pagado', 'rechazado', 'anulado'] as const

export type Estado = (typeof ESTADOS)[number]

const TRANSICIONES: Record<Estado, readonly Estado[]> = {
  pendiente: ['en_revision', 'pagado', 'rechazado', 'anulado'],
  en_revision: ['pendiente', 'pagado', 'rechazado', 'anulado'],
  pagado: ['anulado'],
  rechazado: ['pendiente', 'en_revision', 'anulado'],
  anulado: [],
}

export function esEstadoValido(valor: string): valor is Estado {
  return (ESTADOS as readonly string[]).includes(valor)
}

export function transicionPermitida(desde: string, hacia: string): boolean {
  if (!esEstadoValido(desde) || !esEstadoValido(hacia)) {
    return false
  }

  if (desde === hacia) {
    return true
  }

  return TRANSICIONES[desde].includes(hacia)
}
