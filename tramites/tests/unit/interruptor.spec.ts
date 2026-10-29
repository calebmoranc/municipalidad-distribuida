import { test } from '@japa/runner'
import { ErrorCircuitoAbierto, Interruptor } from '#services/interruptor'

function falla() {
  return Promise.reject(new Error('dependencia caída'))
}

test.group('interruptor | apertura y cierre', () => {
  test('arranca cerrado y sin fallos', ({ assert }) => {
    const interruptor = new Interruptor('prueba')
    const foto = interruptor.foto()
    assert.equal(foto.estado, 'cerrado')
    assert.equal(foto.fallosConsecutivos, 0)
  })

  test('un éxito deja el circuito cerrado', async ({ assert }) => {
    const interruptor = new Interruptor('prueba')
    assert.equal(await interruptor.ejecutar(async () => 42), 42)
    assert.equal(interruptor.estado(), 'cerrado')
  })

  test(`tras ${new Interruptor('x').foto().umbral} fallos se abre y deja de llamar`, async ({
    assert,
  }) => {
    const interruptor = new Interruptor('prueba')
    const umbral = interruptor.foto().umbral

    for (let i = 0; i < umbral; i++) {
      await assert.rejects(() => interruptor.ejecutar(falla))
    }

    assert.equal(interruptor.estado(), 'abierto')

    let llamada = false
    let capturado: unknown
    try {
      await interruptor.ejecutar(async () => {
        llamada = true
      })
    } catch (error) {
      capturado = error
    }

    assert.instanceOf(capturado, ErrorCircuitoAbierto)
    assert.isFalse(llamada, 'no debe tocar la dependencia con el circuito abierto')
  })

  test('pasado el tiempo de espera deja pasar una sola prueba y se cierra', async ({ assert }) => {
    const interruptor = new Interruptor('prueba')
    const umbral = interruptor.foto().umbral
    const realAhora = Date.now
    let reloj = realAhora()

    Date.now = () => reloj
    try {
      for (let i = 0; i < umbral; i++) {
        await assert.rejects(() => interruptor.ejecutar(falla))
      }
      assert.equal(interruptor.estado(), 'abierto')

      // Vence la ventana de apertura: la siguiente llamada es la de prueba.
      reloj += interruptor.foto().seReabreEnMs + 1
      assert.equal(interruptor.estado(), 'enPrueba')

      assert.equal(await interruptor.ejecutar(async () => 'ok'), 'ok')
      assert.equal(interruptor.estado(), 'cerrado')
    } finally {
      Date.now = realAhora
    }
  })
})
