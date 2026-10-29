/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  // Node
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),
  // Database
  DB_CONNECTION: Env.schema.enum(['sqlite', 'pg'] as const),
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string(),
  DB_DATABASE: Env.schema.string(),
  // Timeout para CONSEGUIR una conexion del pool de PostgreSQL. Opcional: si no
  // viene, config/database.ts aplica 2000ms (conexion) y 4000ms (pool).
  DB_CONNECTION_TIMEOUT_MS: Env.schema.number.optional(),
  DB_POOL_TIMEOUT_MS: Env.schema.number.optional(),

  // Identidad de esta replica dentro del sistema distribuido. Opcional:
  // si falta, el reloj logico usa el hostname del contenedor.
  NODE_ID: Env.schema.string.optional(),

  // Secreto compartido para firmar la identidad (X-Identidad) que viaja entre
  // servicios. Opcional: en desarrollo cae a un valor por defecto.
  AUTH_IDENTITY_SECRET: Env.schema.string.optional(),
  AUTH_IDENTITY_SECRET_ANTERIOR: Env.schema.string.optional(),
  REVOCACION_TTL_MS: Env.schema.number.optional(),

  // App
  APP_KEY: Env.schema.secret(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),

  // Session
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory', 'database'] as const),
})
