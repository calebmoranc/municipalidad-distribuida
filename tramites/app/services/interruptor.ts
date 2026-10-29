import env from '#start/env'

/**
 * Interruptor de circuito para una dependencia.
 *
 * Tres estados:
 *
 *   cerrado     normal, la llamada pasa y los fallos se cuentan
 *   abierto     la dependencia esta caida: se responde de inmediato sin llamar
 *               a nadie. Tras `duracionAbiertoMs` vuelve a probarse.
 *   enPrueba    dejo pasar una sola llamada para ver si la dependencia volvio
 *
 * Que sirve: cuando un servicio entero esta caido, nginx ya tardaba varios
 * segundos en responder. Sin el interruptor, cada peticion del cliente pagaba esa
 * espera. Con el, las primeras N pedidos abren el circuito y las siguientes
 * fallan en milisegundos, y ademas el sistema deja de golpear a un servicio que
 * no responde.
 */

export type Estado = 'cerrado' | 'abierto' | 'enPrueba'

function entero(nombre: string, porDefecto: number): number {
  const valor = env.get(nombre)
  const numero = Number(valor)
  return Number.isFinite(numero) && numero > 0 ? numero : porDefecto
}

export class ErrorCircuitoAbierto extends Error {
  constructor(nombre: string) {
    super(`El circuito de ${nombre} esta abierto: no se intenta la llamada`)
    this.name = 'ErrorCircuitoAbierto'
  }
}

export class Interruptor {
  #nombre: string
  #umbral: number
  #duracionAbiertoMs: number
  #fallosConsecutivos = 0
  #abiertoHasta = 0
  #enPrueba = false

  constructor(nombre: string) {
    this.#nombre = nombre
    this.#umbral = entero('CIRCUIT_UMBRAL', 3)
    this.#duracionAbiertoMs = entero('CIRCUIT_ABIERTO_MS', 10_000)
  }

  get nombre(): string {
    return this.#nombre
  }

  estado(): Estado {
    if (Date.now() < this.#abiertoHasta) {
      return 'abierto'
    }

    // El tiempo de espera ya vencio pero los fallos siguen acumulados: toca
    // dejar pasar una llamada de prueba para ver si la dependencia revivio.
    if (this.#fallosConsecutivos >= this.#umbral) {
      return 'enPrueba'
    }

    return 'cerrado'
  }

  /**
   * Ejecuta la operacion si el circuito lo permite. Un fallo cuenta como fallo
   * del circuito; un exito lo resets.
   */
  async ejecutar<T>(operacion: () => Promise<T>): Promise<T> {
    if (Date.now() < this.#abiertoHasta) {
      throw new ErrorCircuitoAbierto(this.#nombre)
    }

    if (this.#fallosConsecutivos >= this.#umbral) {
      // Ventana de prueba: pasa una sola llamada. Si funciona, el circuito se
      // cierra; si falla, vuelve a abrirse. Las concurrentes siguen fallando
      // rapido para no saturar un servicio que esta volviendo.
      if (this.#enPrueba) {
        throw new ErrorCircuitoAbierto(this.#nombre)
      }

      this.#enPrueba = true
    }

    try {
      const resultado = await operacion()
      this.#fallosConsecutivos = 0
      this.#abiertoHasta = 0
      this.#enPrueba = false
      return resultado
    } catch (error) {
      this.#fallosConsecutivos += 1
      this.#enPrueba = false

      if (this.#fallosConsecutivos >= this.#umbral) {
        this.#abiertoHasta = Date.now() + this.#duracionAbiertoMs
      }

      throw error
    }
  }

  /** Foto del circuito, para poder observarla con curl. */
  foto() {
    return {
      dependencia: this.#nombre,
      estado: this.estado(),
      fallosConsecutivos: this.#fallosConsecutivos,
      umbral: this.#umbral,
      seReabreEnMs: Math.max(0, this.#abiertoHasta - Date.now()),
    }
  }
}
