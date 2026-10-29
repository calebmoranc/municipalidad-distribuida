import app from '@adonisjs/core/services/app'
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
  /**
   * Default connection used for all queries.
   */
  //connection: 'sqlite',
  connection: env.get('DB_CONNECTION'),
  connections: {
    /**
     * SQLite connection (default).
     */
    sqlite: {
      client: 'better-sqlite3',

      connection: {
        filename: app.tmpPath('db.sqlite3'),
      },

      /**
       * Required by Knex for SQLite defaults.
       */
      useNullAsDefault: true,

      migrations: {
        /**
         * Sort migration files naturally by filename.
         */
        naturalSort: true,

        /**
         * Paths containing migration files.
         */
        paths: ['database/migrations'],
      },

      schemaGeneration: {
        /**
         * Enable schema generation from Lucid models.
         */
        enabled: true,

        /**
         * Custom schema rules file paths.
         */
        rulesPaths: ['./database/schema_rules.js'],
      },
    },

    /**
     * PostgreSQL connection.
     * Install package to switch: npm install pg
     */
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
      debug: app.inDev,
    },

    /**
     * MySQL / MariaDB connection.
     * Install package to switch: npm install mysql2
     */
    // mysql: {
    //   client: 'mysql2',
    //   connection: {
    //     host: env.get('DB_HOST'),
    //     port: env.get('DB_PORT'),
    //     user: env.get('DB_USER'),
    //     password: env.get('DB_PASSWORD'),
    //     database: env.get('DB_DATABASE'),
    //   },
    //   migrations: {
    //     naturalSort: true,
    //     paths: ['database/migrations'],
    //   },
    //   debug: app.inDev,
    // },

    /**
     * Microsoft SQL Server connection.
     * Install package to switch: npm install tedious
     */
    // mssql: {
    //   client: 'mssql',
    //   connection: {
    //     server: env.get('DB_HOST'),
    //     port: env.get('DB_PORT'),
    //     user: env.get('DB_USER'),
    //     password: env.get('DB_PASSWORD'),
    //     database: env.get('DB_DATABASE'),
    //   },
    //   migrations: {
    //     naturalSort: true,
    //     paths: ['database/migrations'],
    //   },
    //   debug: app.inDev,
    // },

    /**
     * libSQL (Turso) connection.
     * Install package to switch: npm install @libsql/client
     */
    // libsql: {
    //   client: 'libsql',
    //   connection: {
    //     url: env.get('LIBSQL_URL'),
    //     authToken: env.get('LIBSQL_AUTH_TOKEN'),
    //   },
    //   useNullAsDefault: true,
    //   migrations: {
    //     naturalSort: true,
    //     paths: ['database/migrations'],
    //   },
    //   debug: app.inDev,
    // },
  },
})

export default dbConfig
