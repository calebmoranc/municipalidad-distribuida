import { test } from '@japa/runner'
import { ESTADOS, esEstadoValido, transicionPermitida } from '#services/estados'

test.group('estados | catálogo', () => {
  test('reconoce solo los estados del catálogo', ({ assert }) => {
    for (const estado of ESTADOS) {
      assert.isTrue(esEstadoValido(estado))
    }

    for (const inventado of ['', 'PAGADO', 'en revisión', 'borrado', 'pagado ']) {
      assert.isFalse(esEstadoValido(inventado))
    }
  })

  test('el estado inicial es pendiente', ({ assert }) => {
    assert.equal(ESTADOS[0], 'pendiente')
  })
})

test.group('estados | transiciones', () => {
  test('desde pendiente se puede pasar a los cuatro estados operativos', ({ assert }) => {
    for (const hacia of ['en_revision', 'pagado', 'rechazado', 'anulado']) {
      assert.isTrue(transicionPermitida('pendiente', hacia), `pendiente → ${hacia}`)
    }
  })

  test('repetir el estado actual es idempotente', ({ assert }) => {
    for (const estado of ESTADOS) {
      assert.isTrue(transicionPermitida(estado, estado), `${estado} → ${estado}`)
    }
  })

  test('pagado solo puede anularse', ({ assert }) => {
    assert.isTrue(transicionPermitida('pagado', 'anulado'))
    for (const hacia of ['pendiente', 'en_revision', 'rechazado']) {
      assert.isFalse(transicionPermitida('pagado', hacia), `pagado → ${hacia}`)
    }
  })

  test('anulado es terminal', ({ assert }) => {
    for (const hacia of ESTADOS) {
      assert.equal(transicionPermitida('anulado', hacia), hacia === 'anulado')
    }
  })

  test('rechazado puede volver a revisión o anularse', ({ assert }) => {
    for (const hacia of ['pendiente', 'en_revision', 'anulado']) {
      assert.isTrue(transicionPermitida('rechazado', hacia), `rechazado → ${hacia}`)
    }
    assert.isFalse(transicionPermitida('rechazado', 'pagado'))
  })

  test('rechaza estados desconocidos en cualquiera de los dos lados', ({ assert }) => {
    assert.isFalse(transicionPermitida('pendiente', 'inventado'))
    assert.isFalse(transicionPermitida('inventado', 'pagado'))
  })
})
