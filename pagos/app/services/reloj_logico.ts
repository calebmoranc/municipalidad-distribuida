import env from '#start/env'
import { hostname } from 'node:os'

/**
 * Reloj logico de Lamport.
 *
 * No mide tiempo de pared: es un contador que depende solo del orden en que un
 * proceso observa los eventos. Reglas de Lamport (1978):
 *
 *   L1. En todo evento local el contador avanza en uno.
 *   L2. Si A envia un mensaje a B con sello s, B cumple C := max(C, s) + 1.
 *
 * Consecuencia util: si el sello de A es menor que el de B, A ocurrio antes que B
 * de forma garantizada. Si A es mayor que B no se puede deducir nada, porque un
 * proceso que arranca mas tarde ya empieza con un valor mayor. Para eso estan
 * node_id y los relojes remotos.
 *
 * El estado es por proceso: cada replica es un proceso independiente y por eso
 * tiene su propio contador. No se persiste entre reinicios, que es justo lo que
 * hace un reloj logico (solo necesita el orden parcial de una ejecucion).
 */

let contador = 0

/**
 * Identificador de esta replica. Si no viene en el entorno se usa el hostname,
 * que en Docker es el identificador unico del contenedor.
 */
export function idNodo(): string {
  return env.get('NODE_ID') || hostname()
}

export function ahora(): number {
  return contador
}

/** Evento local. Regla L1. */
export function tick(): number {
  contador += 1
  return contador
}

/**
 * Evento de envio. El contador avanza y devuelve el sello que viaja en la cabecera
 * del mensaje.
 */
export function enviar(): { lamport: number; cabeceras: Record<string, string> } {
  const lamport = tick()
  return { lamport, cabeceras: { 'X-Lamport': String(lamport) } }
}

/**
 * Evento de recepcion. Regla L2: el contador sube hasta el sello recibido y
 * avanza uno mas.
 */
export function recibir(sello: string | null | undefined): number {
  const remoto = Number(sello)

  if (Number.isFinite(remoto) && remoto > contador) {
    contador = remoto
  }

  return tick()
}

export function estado(): { nodeId: string; lamport: number } {
  return { nodeId: idNodo(), lamport: contador }
}
