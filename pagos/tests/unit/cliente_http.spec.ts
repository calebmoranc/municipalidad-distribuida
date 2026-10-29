import { test } from '@japa/runner'
import { metricas, pedir, reiniciarMetricas } from '#services/cliente_http'

function respuesta(status: number): Response {
  return new Response('', { status })
}

test.group('cliente HTTP | métricas y reintentos adaptativos', (group) => {
  group.each.setup(() => {
    reiniciarMetricas()
    const original = globalThis.fetch

    return () => {
      globalThis.fetch = original
      reiniciarMetricas()
    }
  })

  test('una llamada exitosa deja tasa de fallo en cero', async ({ assert }) => {
    globalThis.fetch = (async () => respuesta(200)) as typeof fetch

    await pedir({ url: 'http://ejemplo', dependencia: 'prueba' })

    const m = metricas('prueba')
    assert.equal(m.llamadas, 1)
    assert.equal(m.exitos, 1)
    assert.equal(m.fallos, 0)
    assert.equal(m.reintentos, 0)
    assert.equal(m.tasaFallo, 0)
  })

  test('un 404 cuenta como éxito: la dependencia respondió', async ({ assert }) => {
    globalThis.fetch = (async () => respuesta(404)) as typeof fetch

    await pedir({ url: 'http://ejemplo', dependencia: 'prueba' })

    const m = metricas('prueba')
    assert.equal(m.exitos, 1)
    assert.equal(m.fallos, 0)
  })

  test('un 503 seguido de 200 registra un reintento y un éxito', async ({ assert }) => {
    let llamadas = 0
    globalThis.fetch = (async () => {
      llamadas += 1
      return llamadas === 1 ? respuesta(503) : respuesta(200)
    }) as typeof fetch

    const r = await pedir({ url: 'http://ejemplo', dependencia: 'prueba' })

    assert.equal(r.status, 200)
    const m = metricas('prueba')
    assert.equal(m.llamadas, 1)
    assert.equal(m.reintentos, 1)
    assert.equal(m.exitos, 1)
  })

  test('tras cinco fallos la dependencia deja de recibir reintentos', async ({ assert }) => {
    let llamadas = 0
    globalThis.fetch = (async () => {
      llamadas += 1
      return respuesta(503)
    }) as typeof fetch

    for (let i = 0; i < 5; i++) {
      await pedir({ url: 'http://ejemplo', dependencia: 'prueba' })
    }

    // Con HTTP_REINTENTOS=1 cada llamada hace dos intentos.
    assert.equal(llamadas, 10)
    assert.equal(metricas('prueba').tasaFallo, 1)

    llamadas = 0
    await pedir({ url: 'http://ejemplo', dependencia: 'prueba' })

    // La sexta ya no reintenta: falla rápido.
    assert.equal(llamadas, 1)
  })
})
