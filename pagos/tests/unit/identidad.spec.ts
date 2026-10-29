import { test } from '@japa/runner'
import {
  ROLES,
  crearIdentidad,
  crearIdentidadConSecreto,
  jtiDe,
  verificarConSecretos,
  verificarIdentidad,
} from '#services/identidad'
import { limpiarRevocacionesParaPruebas, marcarRevocadaParaPruebas } from '#services/revocaciones'

test.group('identidad firmada | rotación y revocación', (group) => {
  group.each.setup(() => {
    limpiarRevocacionesParaPruebas()
    return () => limpiarRevocacionesParaPruebas()
  })

  test('una identidad válida conserva id y rol', ({ assert }) => {
    const token = crearIdentidad({ id: '10000001', rol: ROLES.tesoreria })
    assert.deepEqual(verificarIdentidad(token), { id: '10000001', rol: ROLES.tesoreria })
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
