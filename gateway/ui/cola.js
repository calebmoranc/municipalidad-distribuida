/**
 * Cola local de trámites.
 *
 * Si el POST no llega al servidor (sin red, gateway caído o 5xx), el trámite se
 * guarda en el navegador y se reintenta automáticamente. Cada elemento lleva
 * una clave de idempotencia para que un reintento no cree un duplicado.
 *
 * Se usa localStorage a propósito: es síncrono, está disponible en cualquier
 * navegador y para una demostración con pocos trámites es suficiente. El día
 * que la cola crezca, este módulo se puede cambiar a IndexedDB sin tocar la UI.
 */
;(function () {
  const CLAVE = 'municipalidad.cola.tramites'
  const MAX_HISTORIAL = 20
  const REINTENTABLES = [0, 408, 425, 429, 500, 502, 503, 504]

  let sincronizando = false

  function leer() {
    try {
      const crudo = localStorage.getItem(CLAVE)
      const lista = crudo ? JSON.parse(crudo) : []

      if (!Array.isArray(lista)) return []

      return lista.map((item) => ({
        ...item,
        estado: item.estado || 'pendiente',
        intentos: Number(item.intentos) || 0,
      }))
    } catch {
      return []
    }
  }

  function guardar(items) {
    try {
      localStorage.setItem(CLAVE, JSON.stringify(items))
    } catch {
      throw new Error('No hay espacio en el navegador para guardar el trámite pendiente.')
    }
  }

  function nuevaClave() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()

    if (globalThis.crypto?.getRandomValues) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }

    return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  function esReintentable(status) {
    return REINTENTABLES.includes(Number(status))
  }

  function espera(intentos) {
    return Math.min(5 * 60 * 1000, 5000 * 2 ** Math.min(Math.max(intentos - 1, 0), 6))
  }

  function listar(actorId) {
    if (!actorId) return []

    return leer()
      .filter((item) => item.actorId === actorId)
      .sort((a, b) => String(a.encoladoEn).localeCompare(String(b.encoladoEn)))
  }

  function pendientes(actorId) {
    return listar(actorId).filter((item) => item.estado === 'pendiente' || item.estado === 'enviando')
  }

  function encolar(item) {
    const items = leer()
    const existente = items.find((i) => i.id === item.id)

    if (existente) return existente

    const nuevo = {
      estado: 'pendiente',
      intentos: 0,
      ultimoError: '',
      ultimoIntentoEn: null,
      enviadoEn: null,
      respuestaId: null,
      siguienteIntentoEn: null,
      encoladoEn: new Date().toISOString(),
      ...item,
    }

    items.push(nuevo)
    guardar(items)
    return nuevo
  }

  function actualizar(id, cambios) {
    const items = leer()
    const indice = items.findIndex((item) => item.id === id)
    if (indice === -1) return null

    items[indice] = { ...items[indice], ...cambios }
    guardar(items)
    return items[indice]
  }

  function eliminar(id) {
    const items = leer().filter((item) => item.id !== id)
    guardar(items)
  }

  function reintentar(id) {
    return actualizar(id, {
      estado: 'pendiente',
      siguienteIntentoEn: null,
      ultimoError: '',
    })
  }

  function podar(actorId) {
    const items = leer()
    const propios = items.filter((item) => item.actorId === actorId)
    const otros = items.filter((item) => item.actorId !== actorId)
    const enviados = propios.filter((item) => item.estado === 'enviado').slice(-MAX_HISTORIAL)
    const resto = propios.filter((item) => item.estado !== 'enviado')

    guardar([...otros, ...resto, ...enviados])
  }

  async function sincronizar({ actorId, enviar, alCambiar, forzar = false } = {}) {
    const resumen = { enviados: 0, fallidos: 0, pendientes: 0, pausado: false }

    if (!actorId || sincronizando) {
      resumen.pendientes = pendientes(actorId).length
      return resumen
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      resumen.pendientes = pendientes(actorId).length
      return resumen
    }

    sincronizando = true

    try {
      // Un elemento en 'enviando' al empezar solo puede venir de una pestaña
      // que se cerró a mitad del envío: nadie lo está procesando ahora.
      const items = listar(actorId).filter(
        (item) => item.estado === 'pendiente' || item.estado === 'enviando'
      )
      for (const item of items) {
        if (item.estado === 'enviando') actualizar(item.id, { estado: 'pendiente' })
      }

      for (const item of items) {
        if (!forzar && item.siguienteIntentoEn && Date.parse(item.siguienteIntentoEn) > Date.now()) continue

        actualizar(item.id, {
          estado: 'enviando',
          ultimoIntentoEn: new Date().toISOString(),
        })
        alCambiar?.()

        try {
          const respuesta = await enviar(item)
          const id = respuesta?.id ?? respuesta?.data?.id ?? null

          actualizar(item.id, {
            estado: 'enviado',
            enviadoEn: new Date().toISOString(),
            respuestaId: id,
            ultimoError: '',
            siguienteIntentoEn: null,
            intentos: item.intentos + 1,
          })
          resumen.enviados++
        } catch (error) {
          const status = Number(error?.status) || 0
          const intentos = item.intentos + 1
          const cambios = {
            estado: 'pendiente',
            intentos,
            ultimoError: error?.message || 'No se pudo enviar',
            ultimoIntentoEn: new Date().toISOString(),
            siguienteIntentoEn: null,
          }

          if (status === 401) {
            // La sesión caducó: no se descarta nada. Se reintentará cuando el
            // usuario vuelva a entrar.
            cambios.siguienteIntentoEn = new Date(Date.now() + 60000).toISOString()
            actualizar(item.id, cambios)
            resumen.pausado = true
            break
          }

          if (esReintentable(status)) {
            cambios.siguienteIntentoEn = new Date(Date.now() + espera(intentos)).toISOString()
            actualizar(item.id, cambios)
            resumen.fallidos++
            resumen.pausado = true
            break
          }

          // 400/403/404/409...: reintentar no sirve. Queda visible para que el
          // usuario lo corrija o lo descarte.
          cambios.estado = 'error'
          actualizar(item.id, cambios)
          resumen.fallidos++
        }

        alCambiar?.()
      }
    } finally {
      sincronizando = false
      podar(actorId)
      alCambiar?.()
    }

    resumen.pendientes = pendientes(actorId).length
    return resumen
  }

  window.ColaOffline = {
    nuevaClave,
    esReintentable,
    listar,
    pendientes,
    encolar,
    actualizar,
    eliminar,
    reintentar,
    sincronizar,
  }
})()
