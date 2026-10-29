import { test } from '@japa/runner'
import {
  ROLES,
  crearIdentidad,
  crearIdentidadConSecreto,
  crearIdentidadServicio,
  esPrivilegiado,
  jtiDe,
  verificarConSecretos,
  verificarIdentidad,
} from '#services/identidad'
import { limpiarRevocacionesParaPruebas, marcarRevocadaParaPruebas } from '#services/revocaciones'

test.group('identidad firmada | firma y verificación', () => {
  test('una identidad válida conserva id y rol', ({ assert }) => {
    const token = crearIdentidad({ id: '10000001', rol: ROLES.admin })
    assert.deepEqual(verificarIdentidad(token), { id: '10000001', rol: ROLES.admin })
  })

  test('rechaza una firma manipulada', ({ assert }) => {
    const token = crearIdentidad({ id: '10000001', rol: ROLES.ciudadano })
    const [cuerpo] = token.split('.')
    assert.isNull(verificarIdentidad(`${cuerpo}.firma-inventada`))
  })

  test('rechaza un token expirado', ({ assert }) => {
    const token = crearIdentidad({ id: '10000001', rol: ROLES.ciudadano }, -1)
    assert.isNull(verificarIdentidad(token))
  })

  test('rechaza tokens malformados o vacíos', ({ assert }) => {
    for (const token of [null, undefined, '', 'solo-cuerpo', 'a.b.c', '.']) {
      assert.isNull(verificarIdentidad(token))
    }
  })

  test('la identidad de servicio dura poco y usa el rol servicio', ({ assert }) => {
    const identidad = verificarIdentidad(crearIdentidadServicio())
    assert.deepEqual(identidad, { id: 'servicio', rol: ROLES.servicio })
  })
})

test.group('identidad firmada | permisos', () => {
  test('solo admin y tesorería son privilegiados', ({ assert }) => {
    assert.isTrue(esPrivilegiado(ROLES.admin))
    assert.isTrue(esPrivilegiado(ROLES.tesoreria))
    assert.isFalse(esPrivilegiado(ROLES.ciudadano))
    assert.isFalse(esPrivilegiado(ROLES.servicio))
    assert.isFalse(esPrivilegiado(undefined))
    assert.isFalse(esPrivilegiado(null))
  })
})

test.group('identidad firmada | rotación y revocación', (group) => {
  group.each.setup(() => {
    limpiarRevocacionesParaPruebas()
    return () => limpiarRevocacionesParaPruebas()
  })

  test('acepta el secreto anterior durante la rotación', ({ assert }) => {
    const token = crearIdentidadConSecreto('secreto-viejo', {
      id: '10000001',
      rol: ROLES.admin,
    })

    assert.isNull(verificarConSecretos(token, ['secreto-nuevo']))
    assert.deepEqual(verificarConSecretos(token, ['secreto-nuevo', 'secreto-viejo']), {
      id: '10000001',
      rol: ROLES.admin,
    })
  })

  test('rechaza una identidad revocada antes de que caduque', ({ assert }) => {
    const token = crearIdentidad({ id: '10000001', rol: ROLES.ciudadano })
    const jti = jtiDe(token)

    assert.isString(jti)
    assert.deepEqual(verificarIdentidad(token), { id: '10000001', rol: ROLES.ciudadano })

    marcarRevocadaParaPruebas(jti!)
    assert.isNull(verificarIdentidad(token))
  })
})
