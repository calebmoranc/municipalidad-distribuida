import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'
import User from '#models/user'
import { crearIdentidad } from '#services/identidad'

let contador = 0

function datosUsuario(extra: Record<string, unknown> = {}) {
  contador += 1
  const dni = String(20000000 + contador)
  return {
    dni,
    fullName: 'Prueba Japa',
    email: `japa${contador}@mun.test`,
    password: 'secreto123',
    passwordConfirmation: 'secreto123',
    ...extra,
  }
}

test.group('auth | registro', (group) => {
  group.setup(() => testUtils.db().migrate())

  test('crea la cuenta con el DNI como id y rol ciudadano', async ({ client, assert }) => {
    const datos = datosUsuario()
    const respuesta = await client.post('/api/v1/auth/signup').json(datos)

    respuesta.assertStatus(200)
    respuesta.assertBodyContains({ data: { user: { id: datos.dni, rol: 'ciudadano' } } })

    const cuerpo = respuesta.body() as {
      data: { token: string; identidad: string; user: Record<string, unknown> }
    }
    assert.isString(cuerpo.data.token)
    assert.isString(cuerpo.data.identidad)
    assert.notProperty(cuerpo.data.user, 'password')
  })

  test('rechaza el registro sin DNI', async ({ client }) => {
    const sinDni: Record<string, unknown> = { ...datosUsuario() }
    delete sinDni.dni
    // El cliente tipa el cuerpo según el contrato; aquí se envía a propósito un
    // cuerpo inválido para comprobar que el servidor lo rechaza.
    const respuesta = await client.post('/api/v1/auth/signup').json(sinDni as never)
    respuesta.assertStatus(422)
  })

  test('rechaza un DNI que no tiene 8 dígitos', async ({ client }) => {
    const respuesta = await client.post('/api/v1/auth/signup').json(datosUsuario({ dni: '123' }))
    respuesta.assertStatus(422)
  })

  test('no permite repetir el DNI', async ({ client, assert }) => {
    const datos = datosUsuario()
    const alta = await client.post('/api/v1/auth/signup').json(datos)
    alta.assertStatus(200)

    const repetido = await client
      .post('/api/v1/auth/signup')
      .json({ ...datos, email: `otro${Date.now()}@mun.test` })

    assert.include([409, 422], repetido.status())
  })
})

test.group('auth | login y perfil', (group) => {
  group.setup(() => testUtils.db().migrate())

  test('el login devuelve token e identidad firmada', async ({ client, assert }) => {
    const datos = datosUsuario()
    const alta = await client.post('/api/v1/auth/signup').json(datos)
    alta.assertStatus(200)

    const respuesta = await client
      .post('/api/v1/auth/login')
      .json({ email: datos.email, password: datos.password })

    respuesta.assertStatus(200)
    const cuerpo = respuesta.body() as { data: { token: string; identidad: string } }
    assert.isString(cuerpo.data.token)
    assert.isString(cuerpo.data.identidad)
  })

  test('rechaza credenciales incorrectas', async ({ client }) => {
    const datos = datosUsuario()
    const alta = await client.post('/api/v1/auth/signup').json(datos)
    alta.assertStatus(200)

    const respuesta = await client
      .post('/api/v1/auth/login')
      .json({ email: datos.email, password: 'incorrecta' })

    // AdonisJS responde 400 para E_INVALID_CREDENTIALS (no 401): validamos el
    // contrato real del proyecto.
    respuesta.assertStatus(400)
  })

  test('el perfil exige token y conserva el rol', async ({ client }) => {
    const datos = datosUsuario()
    const alta = await client.post('/api/v1/auth/signup').json(datos)
    alta.assertStatus(200)
    const token = (alta.body() as { data: { token: string } }).data.token

    const sinToken = await client.get('/api/v1/account/profile')
    sinToken.assertStatus(401)

    const perfil = await client
      .get('/api/v1/account/profile')
      .header('Authorization', `Bearer ${token}`)

    perfil.assertStatus(200)
    perfil.assertBodyContains({ data: { user: { id: datos.dni, rol: 'ciudadano' } } })
  })
})

test.group('auth | permisos de administración', (group) => {
  group.setup(() => testUtils.db().migrate())

  test('solo el admin puede listar usuarios', async ({ client }) => {
    const sufijo = String(Date.now()).slice(-6)
    const admin = await User.create({
      id: `30${sufijo}`,
      fullName: 'Admin Prueba',
      email: `admin${Date.now()}@mun.test`,
      password: 'secreto123',
      rol: 'admin',
    })

    const sinIdentidad = await client.get('/api/v1/usuarios')
    sinIdentidad.assertStatus(401)

    const ciudadano = crearIdentidad({ id: '20000099', rol: 'ciudadano' })
    const comoCiudadano = await client.get('/api/v1/usuarios').header('X-Identidad', ciudadano)
    comoCiudadano.assertStatus(403)

    const identidadAdmin = crearIdentidad({ id: admin.id, rol: 'admin' })
    const listado = await client.get('/api/v1/usuarios').header('X-Identidad', identidadAdmin)

    listado.assertStatus(200)
  })
})
