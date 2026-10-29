import db from '@adonisjs/lucid/services/db'

/**
 * Identidades revocadas antes de su caducidad.
 *
 * Se mantiene un Set en memoria para que la verificación siga siendo local y
 * barata. La tabla es la fuente de verdad (sobrevive reinicios y es compartida
 * por las réplicas); el Set se recarga cada pocos segundos o al arrancar.
 */

const TTL_MS = 5000

let revocadas = new Set<string>()
let ultimaCarga = 0
let cargando: Promise<void> | null = null

export async function cargarRevocadas(): Promise<void> {
  const filas = await db.from('identidades_revocadas').where('exp', '>', new Date()).select('jti')

  revocadas = new Set(filas.map((fila) => String(fila.jti)))
  ultimaCarga = Date.now()
}

export function estaRevocada(jti?: string | null): boolean {
  if (!jti) return false

  if (Date.now() - ultimaCarga > TTL_MS && !cargando) {
    cargando = cargarRevocadas()
      .catch(() => {
        // Si la base no responde se conserva la última lista conocida.
      })
      .finally(() => {
        cargando = null
      })
  }

  return revocadas.has(jti)
}

export async function revocar(jti: string, exp: number): Promise<void> {
  revocadas.add(jti)
  ultimaCarga = Date.now()

  await db
    .table('identidades_revocadas')
    .insert({
      jti,
      exp: new Date(exp * 1000),
      created_at: new Date(),
    })
    .onConflict('jti')
    .ignore()
}

export async function listarRevocadas(): Promise<string[]> {
  const filas = await db.from('identidades_revocadas').where('exp', '>', new Date()).select('jti')

  return filas.map((fila) => String(fila.jti))
}

/** Utilidades para las pruebas unitarias: no tocan la base. */
export function limpiarRevocacionesParaPruebas(): void {
  revocadas = new Set<string>()
  ultimaCarga = Date.now()
}

export function marcarRevocadaParaPruebas(jti: string): void {
  revocadas.add(jti)
  ultimaCarga = Date.now()
}
