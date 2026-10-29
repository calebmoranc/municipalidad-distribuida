import { test } from '@japa/runner'
import { ahora, enviar, recibir, tick } from '#services/reloj_logico'

test.group('reloj lógico | reglas de Lamport', () => {
  test('un evento local avanza el contador en uno (L1)', ({ assert }) => {
    const antes = ahora()
    const despues = tick()
    assert.equal(despues, antes + 1)
    assert.equal(ahora(), despues)
  })

  test('un envío avanza y devuelve el sello en la cabecera', ({ assert }) => {
    const antes = ahora()
    const { lamport, cabeceras } = enviar()
    assert.equal(lamport, antes + 1)
    assert.equal(cabeceras['X-Lamport'], String(lamport))
  })

  test('al recibir un sello mayor, salta a max(C, remoto) + 1 (L2)', ({ assert }) => {
    tick()
    const local = ahora()
    const remoto = local + 100
    assert.equal(recibir(String(remoto)), remoto + 1)
  })

  test('al recibir un sello menor, solo avanza uno', ({ assert }) => {
    tick()
    tick()
    const local = ahora()
    assert.equal(recibir(String(local - 1)), local + 1)
  })

  test('un sello inválido no rompe el reloj: avanza uno', ({ assert }) => {
    const local = ahora()
    assert.equal(recibir('no-es-un-numero'), local + 1)
    assert.equal(recibir(undefined), local + 2)
  })
})
