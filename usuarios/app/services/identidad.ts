import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import env from '#start/env'
import { estaRevocada } from '#services/revocaciones'

/**
 * Identidad firmada que viaja del cliente a los servicios.
 *
 * ¿Por qué no usar el token opaco de Adonis en trámites y pagos? Porque esos
 * tokens viven en `usuarios_db`, y para validarlos habría que preguntarle a
 * usuarios en cada petición. Eso convertiría a usuarios en una dependencia
 * obligatoria de todo el sistema: si se cae, trámites y pagos dejan de responder
 * aunque estén perfectamente sanos. Justo lo contrario de lo que demuestra el
 * proyecto.
 *
 * En su lugar, usuarios firma un token con un secreto compartido (HMAC-SHA256).
 * Los demás servicios lo verifican localmente, sin llamadas de red. El token
 * lleva el id, el rol y un `jti` único, y caduca.
 *
 * Rotación: se firma siempre con el secreto actual y se aceptan el actual y el
 * anterior (`AUTH_IDENTITY_SECRET_ANTERIOR`). Así se puede cambiar el secreto
 * sin invalidar de golpe las identidades que ya están en uso. Si se quiere
 * revocar TODO, basta con no configurar el anterior.
 *
 * Revocación individual: el `jti` se anota en `identidades_revocadas` y se
 * consulta al verificar. En este servicio la lista está en memoria; los demás
 * la piden y la cachean unos segundos.
 */

const SECRETO = env.get('AUTH_IDENTITY_SECRET') || 'municipalidad-identidad-dev'
const SECRETO_ANTERIOR = env.get('AUTH_IDENTITY_SECRET_ANTERIOR')
const SECRETOS = [SECRETO, SECRETO_ANTERIOR].filter((s): s is string => Boolean(s))
const TTL_POR_DEFECTO = 12 * 60 * 60

export type Identidad = {
  id: string
  rol: string
}

type IdentidadConCaducidad = {
  sub: string
  rol: string
  iat: number
  exp: number
  jti?: string
}

export const ROLES = {
  ciudadano: 'ciudadano',
  tesoreria: 'personal_muni_tesoreria',
  admin: 'admin',
  servicio: 'servicio',
} as const

export function esPrivilegiado(rol: string | undefined | null): boolean {
  return rol === ROLES.admin || rol === ROLES.tesoreria
}

function firmar(cuerpo: string, secreto: string): string {
  return createHmac('sha256', secreto).update(cuerpo).digest('base64url')
}

export function crearIdentidadConSecreto(
  secreto: string,
  identidad: Identidad,
  ttlSegundos = TTL_POR_DEFECTO
): string {
  const ahora = Math.floor(Date.now() / 1000)
  const cuerpo = Buffer.from(
    JSON.stringify({
      sub: identidad.id,
      rol: identidad.rol,
      iat: ahora,
      exp: ahora + ttlSegundos,
      jti: randomUUID(),
    })
  ).toString('base64url')

  return `${cuerpo}.${firmar(cuerpo, secreto)}`
}

export function crearIdentidad(identidad: Identidad, ttlSegundos = TTL_POR_DEFECTO): string {
  return crearIdentidadConSecreto(SECRETO, identidad, ttlSegundos)
}

function verificarConSecreto(token: string, secreto: string): IdentidadConCaducidad | null {
  const partes = token.split('.')
  if (partes.length !== 2) return null

  const [cuerpo, firma] = partes
  if (!cuerpo || !firma) return null

  const recibida = Buffer.from(firma)
  const calculada = Buffer.from(firmar(cuerpo, secreto))

  if (recibida.length !== calculada.length) return null
  if (!timingSafeEqual(recibida, calculada)) return null

  try {
    const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString()) as IdentidadConCaducidad

    if (typeof datos.exp !== 'number' || datos.exp < Math.floor(Date.now() / 1000)) return null
    if (typeof datos.sub !== 'string' || typeof datos.rol !== 'string') return null

    return datos
  } catch {
    return null
  }
}

/**
 * Verifica contra una lista explícita de secretos. El primero es el actual; los
 * siguientes se aceptan durante la rotación. Se exporta para poder probar la
 * rotación sin tocar variables de entorno.
 */
export function verificarConSecretos(token: string, secretos: string[]): Identidad | null {
  for (const secreto of secretos) {
    const datos = verificarConSecreto(token, secreto)

    if (datos) {
      return { id: datos.sub, rol: datos.rol }
    }
  }

  return null
}

/** Datos internos del token, incluido el `jti`, sin comprobar la firma. */
export function datosDe(token: string | null | undefined): IdentidadConCaducidad | null {
  if (!token) return null

  try {
    return JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString())
  } catch {
    return null
  }
}

export function jtiDe(token: string | null | undefined): string | null {
  return datosDe(token)?.jti ?? null
}

export function verificarIdentidad(token: string | null | undefined): Identidad | null {
  if (!token) return null

  const datos = verificarConSecretos(token, SECRETOS)
  if (!datos) return null

  // La firma es válida; además el jti no debe estar revocado antes de expirar.
  const crudo = datosDe(token)
  if (crudo?.jti && estaRevocada(crudo.jti)) return null

  return datos
}

/**
 * Identidad de servicio para las llamadas internas (pagos -> trámites).
 * No representa a una persona: solo acredita que la llamada viene de otro
 * servicio del sistema.
 */
export function crearIdentidadServicio(): string {
  return crearIdentidad({ id: 'servicio', rol: ROLES.servicio }, 120)
}

/**
 * Lee la identidad de una petición. Acepta cualquier objeto con `header` para no
 * atar este módulo a los tipos de AdonisJS.
 */
export function leerIdentidad(request: {
  header(nombre: string): string | undefined
}): Identidad | null {
  return verificarIdentidad(request.header('X-Identidad'))
}
