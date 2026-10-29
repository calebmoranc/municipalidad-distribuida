import { createHmac, randomUUID } from 'node:crypto'
import env from '#start/env'

/**
 * Caché local de identidades revocadas.
 *
 * La lista vive en `usuarios_db`. Para no preguntar en cada petición, cada
 * réplica la descarga cada `REVOCACION_TTL_MS` (5 s por defecto) y responde con
 * lo que tiene. Es consistencia eventual: una revocación tarda como máximo ese
 * TTL en surtir efecto. Si usuarios no responde, se conserva la última lista
 * (fail-open), igual que la verificación de la firma, que es local.
 */

const TTL_MS = env.get('REVOCACION_TTL_MS') ?? 5000
const SECRETO = env.get('AUTH_IDENTITY_SECRET') || 'municipalidad-identidad-dev'
const URL = `${env.get('USUARIOS_SERVICE_URL')}/api/v1/identidades/revocadas`

let revocadas = new Set<string>()
let ultimaCarga = 0
let cargando: Promise<void> | null = null

/**
 * Identidad de servicio mínima para leer la lista. Se construye aquí (y no se
 * importa de identidad.ts) para no crear un ciclo de imports: identidad consulta
 * esta caché al verificar.
 */
function identidadServicio(): string {
  const ahora = Math.floor(Date.now() / 1000)
  const cuerpo = Buffer.from(
    JSON.stringify({
      sub: 'servicio',
      rol: 'servicio',
      iat: ahora,
      exp: ahora + 120,
      jti: randomUUID(),
    })
  ).toString('base64url')

  return `${cuerpo}.${createHmac('sha256', SECRETO).update(cuerpo).digest('base64url')}`
}

async function cargar(): Promise<void> {
  const respuesta = await fetch(URL, {
    headers: { 'X-Identidad': identidadServicio() },
    signal: AbortSignal.timeout(2000),
  })

  if (!respuesta.ok) return

  const datos = (await respuesta.json()) as { jtis?: unknown }
  if (Array.isArray(datos.jtis)) {
    revocadas = new Set(datos.jtis.map((jti) => String(jti)))
    ultimaCarga = Date.now()
  }
}

export function estaRevocada(jti?: string | null): boolean {
  if (!jti) return false

  if (Date.now() - ultimaCarga > TTL_MS && !cargando) {
    cargando = cargar()
      .catch(() => {
        // Se mantiene la última lista conocida.
      })
      .finally(() => {
        cargando = null
      })
  }

  return revocadas.has(jti)
}

/** Utilidades para las pruebas unitarias: no hacen red. */
export function limpiarRevocacionesParaPruebas(): void {
  revocadas = new Set<string>()
  ultimaCarga = Date.now()
}

export function marcarRevocadaParaPruebas(jti: string): void {
  revocadas.add(jti)
  ultimaCarga = Date.now()
}
