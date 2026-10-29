import env from '#start/env'

/**
 * Cliente HTTP para las llamadas entre servicios.
 *
 * Aporta cuatro cosas que `fetch` a pelo no da:
 *
 *   1. Timeout. Sin el, si el servicio acepta la conexion pero no responde, la
 *      peticion se queda esperando hasta que el otro lado la corte.
 *   2. Reintentos con espera creciente, solo para fallos que pueden ser
 *      transitorios (replica reiniciandose, red saturada).
 *   3. No reintenta cuando la respuesta es un 4xx, porque un 404 de tramites o un
 *      400 de usuarios es una respuesta definitiva: reintentar solo retrasa el
 *      error.
 *   4. Metricas por dependencia y reintentos adaptativos: si una dependencia ya
 *      viene fallando, se dejan de hacer reintentos para no amplificar la caida.
 *
 * PRESUPUESTO DE TIEMPO. El peor caso de una llamada es
 *
 *     HTTP_TIMEOUT_MS x (HTTP_REINTENTOS + 1) + esperas de backoff
 *
 * y ese total tiene que quedar POR DEBAJO de `proxy_read_timeout` del gateway
 * (8s). Si no, nginx agota su tiempo de espera antes de que este servicio llegue
 * a gestionar el fallo, lo cuenta como error del upstream y con max_fails=1
 * expulsa a las dos replicas a la vez: el gateway deja de poder llegar aqui.
 *
 * Con los valores por defecto el peor caso es 2000ms x 2 + 100ms = 4.1s.
 * Si subes uno de los tres valores, sube tambien el timeout del gateway.
 */

const CODIGOS_REINTENTABLES = new Set([502, 503, 504])

/**
 * Ventana minima de llamadas antes de que la tasa de fallo pueda influir en los
 * reintentos. Con menos muestras el porcentaje es ruido.
 */
const MUESTRAS_MINIMAS_ADAPTACION = 5

/**
 * Si la dependencia falla al menos esta fraccion de las llamadas, se dejan de
 * hacer reintentos. En una caida sostenida reintentar solo duplica la carga y
 * alarga la respuesta; el interruptor de circuito sigue siendo la primera linea
 * de defensa, y esto evita alimentarlo con reintentos.
 */
const TASA_FALLO_SIN_REINTENTOS = 0.5

export type Opciones = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Nombre de la dependencia, para metricas y reintentos por servicio. */
  dependencia?: string
}

export type MetricasDependencia = {
  dependencia: string
  llamadas: number
  exitos: number
  fallos: number
  reintentos: number
  tasaFallo: number
  latenciaPromedioMs: number
  ultimoError: string | null
}

type Acumulado = {
  llamadas: number
  exitos: number
  fallos: number
  reintentos: number
  latenciaTotalMs: number
  ultimoError: string | null
}

const acumulados = new Map<string, Acumulado>()

function entero(nombre: string, porDefecto: number): number {
  const valor = env.get(nombre)
  const numero = Number(valor)
  return Number.isFinite(numero) && numero > 0 ? numero : porDefecto
}

function acumulado(dependencia: string): Acumulado {
  let actual = acumulados.get(dependencia)
  if (!actual) {
    actual = {
      llamadas: 0,
      exitos: 0,
      fallos: 0,
      reintentos: 0,
      latenciaTotalMs: 0,
      ultimoError: null,
    }
    acumulados.set(dependencia, actual)
  }
  return actual
}

/**
 * Foto de las metricas de una dependencia. `fallos` cuenta 5xx y errores de red,
 * no los 4xx: un 404 significa que la dependencia respondio y esta sana.
 *
 * Es un acumulado en memoria desde que arranco el proceso. Al reiniciar la
 * replica se pierde, igual que el estado de su interruptor.
 */
export function metricas(dependencia: string): MetricasDependencia {
  const a = acumulados.get(dependencia)

  if (!a || a.llamadas === 0) {
    return {
      dependencia,
      llamadas: 0,
      exitos: 0,
      fallos: 0,
      reintentos: 0,
      tasaFallo: 0,
      latenciaPromedioMs: 0,
      ultimoError: null,
    }
  }

  return {
    dependencia,
    llamadas: a.llamadas,
    exitos: a.exitos,
    fallos: a.fallos,
    reintentos: a.reintentos,
    tasaFallo: Number((a.fallos / a.llamadas).toFixed(3)),
    latenciaPromedioMs: Math.round(a.latenciaTotalMs / a.llamadas),
    ultimoError: a.ultimoError,
  }
}

/** Solo para tests: deja el registro como recien arrancado. */
export function reiniciarMetricas(): void {
  acumulados.clear()
}

function registrar(
  dependencia: string,
  exito: boolean,
  reintentos: number,
  latenciaMs: number,
  error: unknown
): void {
  const a = acumulado(dependencia)
  a.llamadas += 1
  a.reintentos += reintentos
  a.latenciaTotalMs += latenciaMs

  if (exito) {
    a.exitos += 1
    return
  }

  a.fallos += 1
  a.ultimoError = error instanceof Error ? error.message : 'Error de red'
}

export function timeoutPorDefecto(): number {
  return entero('HTTP_TIMEOUT_MS', 2000)
}

function sufijo(dependencia?: string): string {
  return dependencia ? `_${dependencia.toUpperCase()}` : ''
}

/**
 * Reintentos base. Se puede ajustar globalmente con `HTTP_REINTENTOS` o por
 * dependencia con `HTTP_REINTENTOS_TRAMITES` / `HTTP_REINTENTOS_USUARIOS`.
 */
export function reintentosPorDefecto(dependencia?: string): number {
  return entero(`HTTP_REINTENTOS${sufijo(dependencia)}`, entero('HTTP_REINTENTOS', 1))
}

/**
 * Reintentos efectivos de esta llamada. Mientras la dependencia tenga pocas
 * muestras se usa la configuracion; si ya falla la mitad o mas, se corta en
 * cero para fallar rapido y no sumar carga.
 */
function reintentosAdaptativos(dependencia?: string): number {
  const base = reintentosPorDefecto(dependencia)

  if (!dependencia) {
    return base
  }

  const a = acumulados.get(dependencia)
  if (!a || a.llamadas < MUESTRAS_MINIMAS_ADAPTACION) {
    return base
  }

  return a.fallos / a.llamadas >= TASA_FALLO_SIN_REINTENTOS ? 0 : base
}

/** Errors que siempre conviene reintentar. */
function esReintentable(error: unknown): boolean {
  // AbortError (timeout), TypeError de fetch (conexion rechazada o caída de red)
  return error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')
}

/**
 * Espera creciente: base * 2^intento, con un tope para no disparar los tiempos
 * de espera. No es backoff exponencial completo, es lo suficiente sin dependencias.
 */
function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function pedir(opciones: Opciones): Promise<Response> {
  const { url, method = 'GET', headers = {}, body, dependencia } = opciones

  const inicio = Date.now()
  const timeoutMs = timeoutPorDefecto()
  const maxIntentos = reintentosAdaptativos(dependencia) + 1

  let ultimoError: unknown
  let reintentosHechos = 0
  let exito = false

  try {
    for (let intento = 1; intento <= maxIntentos; intento++) {
      try {
        const respuesta = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })

        if (!CODIGOS_REINTENTABLES.has(respuesta.status) || intento === maxIntentos) {
          // Un 4xx es una respuesta definitiva y cuenta como exito de la
          // dependencia; un 5xx final si es un fallo.
          exito = respuesta.status < 500
          return respuesta
        }

        // Se descuenta el cuerpo antes de reintentar para no dejar la conexion
        // colgada esperando a que se lea.
        await respuesta.body?.cancel()

        ultimoError = new Error(`El servicio respondio ${respuesta.status}`)
      } catch (error) {
        if (!esReintentable(error) || intento === maxIntentos) {
          throw error
        }

        ultimoError = error
      }

      reintentosHechos += 1
      await esperar(Math.min(100 * 2 ** (intento - 1), 1000))
    }

    throw ultimoError instanceof Error
      ? ultimoError
      : new Error('La peticion fallo sin un error concreto')
  } finally {
    if (dependencia) {
      registrar(dependencia, exito, reintentosHechos, Date.now() - inicio, ultimoError)
    }
  }
}
