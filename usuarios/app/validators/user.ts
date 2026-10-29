import vine from '@vinejs/vine'

/**
 * Shared rules for email and password.
 */
const email = () => vine.string().email().maxLength(254)
const password = () => vine.string().minLength(8).maxLength(32)

/**
 * El DNI es el identificador del usuario: ocho dígitos. Se valida como texto
 * para no perder los ceros a la izquierda y porque es la clave primaria.
 */
const dni = () =>
  vine
    .string()
    .regex(/^\d{8}$/)
    .unique({ table: 'users', column: 'id' })

/**
 * Validator to use when performing self-signup. Cualquiera puede registrarse,
 * pero el rol siempre es 'ciudadano': lo fija el controlador.
 */
export const signupValidator = vine.create({
  dni: dni(),
  fullName: vine.string().nullable(),
  email: email().unique({ table: 'users', column: 'email' }),
  password: password(),
  passwordConfirmation: password().sameAs('password'),
})

/**
 * Creación de una cuenta desde administración. A diferencia del registro
 * público, aquí el administrador sí elige el rol (incluido personal municipal).
 */
export const crearUsuarioValidator = vine.create({
  dni: dni(),
  fullName: vine.string().nullable(),
  email: email().unique({ table: 'users', column: 'email' }),
  password: password(),
  passwordConfirmation: password().sameAs('password'),
  rol: vine.enum(['ciudadano', 'personal_muni_tesoreria', 'admin']),
})

/**
 * Validator to use before validating user credentials
 * during login
 */
export const loginValidator = vine.create({
  email: email(),
  password: vine.string(),
})
