import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'

/**
 * Códigos de error de node-postgres que significan "no pude hablar con PostgreSQL".
 * La lista es de los que se ven en la práctica: la base caída, el servidor que no
 * acepta conexiones, y los que devuelve el pool cuando no hay conexiones libres.
 */
const ES_ERROR_DE_CONEXION = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EAI_AGAIN',
  'CONNECTION_REFUSED',
  'CONNECTION_TIMED_OUT',
  'CONNECTION_ENDED',
  'Unable to acquire a connection',
  'timeout exceeded when trying to acquire a connection',
  'timeout expired',
  'Connection terminated unexpectedly',
]

function esErrorDeConexion(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const codigo = (error as { code?: string }).code
  const mensaje = String((error as { message?: string }).message ?? '')

  if (codigo && ES_ERROR_DE_CONEXION.includes(codigo)) {
    return true
  }

  return ES_ERROR_DE_CONEXION.some((texto) => mensaje.includes(texto))
}

export default class HttpExceptionHandler extends ExceptionHandler {
  /**
   * The method is used for handling errors and returning response to the client.
   *
   * Un fallo de base de datos no es un error del cliente ni un fallo de la
   * logica de negocio: es que esta dependencia no esta disponible. Se responde
   * 503 con un mensaje que lo diga, en vez de un 500 con la traza de conexion
   * dentro, que no le dice nada a quien recibe la respuesta.
   */
  async handle(error: unknown, ctx: HttpContext) {
    if (esErrorDeConexion(error)) {
      logger.warn(
        `sin conexion con la base de datos en ${ctx.request.method()} ${ctx.request.url()}`
      )

      return ctx.response.status(503).send({
        message: 'La base de datos no está disponible',
      })
    }

    return super.handle(error, ctx)
  }

  /**
   * In debug mode, the exception handler will display verbose errors
   * with pretty printed stack traces.
   */
  protected debug = !app.inProduction

  /**
   * The method is used to report error to the logging service or
   * the a third party error monitoring service.
   *
   * @note You should not attempt to send a response from this method.
   */
  async report(error: unknown, ctx: HttpContext) {
    return super.report(error, ctx)
  }
}
