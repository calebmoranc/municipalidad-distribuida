import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

/**
 * Datos de conexion a PostgreSQL.
 *
 * Se declaran aparte para poder tiparlos bien. Los tipos de Lucid para el driver
 * pg solo admiten host, port, user, password y database, pero node-postgres
 * acepta mas opciones y Knex se las reenvia sin filtrar. El `as typeof
 * datosConexion` del final mantiene el tipado del resto sin recurrir a `any`.
 */
const datosConexion = {
  host: env.get('DB_HOST'),
  port: env.get('DB_PORT'),
  user: env.get('DB_USER'),
  password: env.get('DB_PASSWORD'),
  database: env.get('DB_DATABASE'),
}

const dbConfig = defineConfig({
  connection: 'pg',

  connections: {
    pg: {
      client: 'pg',

      connection: {
        ...datosConexion,
        /**
         * Tope de espera para CONSEGUIR una conexion del pool.
         *
         * Sin esto, si PostgreSQL esta caido o no acepta conexiones, una peticion
         * HTTP se queda esperando (~8s medidos) y devuelve un 500 con un error de
         * conexion que no explica nada. Con el tope, falla en 2s y el servicio
         * puede responder 503, que si significa algo.
         *
         * Tiene que quedar por debajo de proxy_read_timeout del gateway (8s),
         * igual que el presupuesto de las llamadas entre servicios.
         */
        connectionTimeoutMillis: env.get('DB_CONNECTION_TIMEOUT_MS', 2000),
      } as typeof datosConexion,

      /**
       * El pool espera 4s por una conexion libre antes de rendirse. Va por
       * encima del timeout de conexion para que el error siga siendo el de
       * "no hay PostgreSQL" y no "no hay conexiones libres en el pool".
       */
      pool: {
        min: 0,
        max: 10,
        acquireTimeoutMillis: env.get('DB_POOL_TIMEOUT_MS', 4000),
      },

      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
    },
  },
})

export default dbConfig
