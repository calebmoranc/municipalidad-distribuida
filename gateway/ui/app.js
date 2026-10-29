/**
 * Interfaz del portal.
 *
 * Es JavaScript sin dependencias a propósito: la interfaz solo consume la API
 * que ya existe a través del gateway, y así no hay que añadir un paso de build
 * al proyecto. Todo lo que se muestra viene de /api/v1/*.
 */

const CLAVE_TOKEN = 'municipalidad.token'
const CLAVE_USUARIO = 'municipalidad.usuario'
const CLAVE_IDENTIDAD = 'municipalidad.identidad'

const estado = {
  token: localStorage.getItem(CLAVE_TOKEN),
  identidad: localStorage.getItem(CLAVE_IDENTIDAD),
  usuario: leerUsuarioGuardado(),
  tramites: [],
  pagos: [],
  usuarios: [],
  tipos: [],
  vista: 'tramites',
  tramiteEditando: null,
  versionEditando: null,
}

function leerUsuarioGuardado() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_USUARIO) || 'null')
  } catch {
    return null
  }
}

/* ============================ Utilidades ============================ */

const $ = (selector, raiz = document) => raiz.querySelector(selector)
const $$ = (selector, raiz = document) => Array.from(raiz.querySelectorAll(selector))

function esc(valor) {
  return String(valor ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Los endpoints que usan `serialize()` (login, signup y perfil) devuelven el
 * resultado dentro de `{ data: ... }`. El resto devuelve el valor directo.
 * Esta función acepta las dos formas.
 */
function desenvolver(respuesta) {
  return respuesta && typeof respuesta === 'object' && 'data' in respuesta
    ? respuesta.data
    : respuesta
}

function fecha(valor) {
  if (!valor) return '—'
  const d = new Date(valor)
  if (Number.isNaN(d.getTime())) return esc(valor)
  return d.toLocaleString('es-CR', { dateStyle: 'medium', timeStyle: 'short' })
}

function dinero(valor) {
  const n = Number(valor)
  return Number.isFinite(n) ? n.toFixed(2) : '—'
}

function iniciales(nombre, email = '') {
  const base = String(nombre || email).trim()
  if (!base) return '??'
  const partes = base.split(/\s+/)
  if (partes.length >= 2) return (partes[0][0] + partes[1][0]).toUpperCase()
  return base.slice(0, 2).toUpperCase()
}

let temporizadorAviso = null

function aviso(mensaje, tipo = '') {
  const caja = $('#aviso')
  caja.textContent = mensaje
  caja.className = `aviso is-visible${tipo ? ` aviso--${tipo}` : ''}`
  clearTimeout(temporizadorAviso)
  temporizadorAviso = setTimeout(() => {
    caja.classList.remove('is-visible')
  }, 4200)
}

function mensajeDeError(cuerpo, status) {
  if (typeof cuerpo === 'string' && cuerpo.trim()) {
    if (/<html|<!doctype/i.test(cuerpo)) {
      return status >= 500
        ? 'El servicio no está disponible en este momento. Intenta de nuevo en unos segundos.'
        : `No se pudo completar la operación (${status}).`
    }
    return cuerpo.slice(0, 240)
  }

  if (cuerpo && Array.isArray(cuerpo.errors) && cuerpo.errors.length) {
    return cuerpo.errors.map((e) => e.message).filter(Boolean).join(' ')
  }

  if (cuerpo && typeof cuerpo === 'object') {
    if (cuerpo.message) return cuerpo.message
    if (cuerpo.mensaje) return cuerpo.mensaje
    if (cuerpo.error) return cuerpo.error
  }

  if (status === 401) return 'Tu sesión expiró. Ingresa de nuevo.'
  if (status === 403) return 'No tienes permiso para esta operación.'
  if (status === 503 || status === 502 || status === 504) {
    return 'El servicio no está disponible en este momento.'
  }
  return `No se pudo completar la operación (${status}).`
}

/* ============================ Cliente HTTP ============================ */

async function api(ruta, opciones = {}) {
  const cabeceras = {
    ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opciones.headers || {}),
  }

  /**
   * El token solo se envía a usuarios. Es el servicio que emite los tokens y el
   * único que tiene la tabla auth_access_tokens; si se envía a trámites o pagos,
   * su middleware de autenticación intenta validarlo contra su propia base y
   * responde 500 porque esa tabla no existe allí.
   */
  if (estado.token && ruta.startsWith('/api/v1/account')) {
    cabeceras.Authorization = `Bearer ${estado.token}`
  }

  /**
   * La identidad firmada es la que entienden trámites y pagos (y la lista de
   * usuarios). Se renueva al iniciar sesión y al cargar el perfil.
   */
  if (estado.identidad && !ruta.startsWith('/api/v1/auth')) {
    cabeceras['X-Identidad'] = estado.identidad
  }

  let respuesta
  try {
    respuesta = await fetch(ruta, { ...opciones, headers: cabeceras })
  } catch {
    const error = new Error('No hay conexión con el servidor.')
    error.status = 0
    throw error
  }

  const texto = await respuesta.text()
  let cuerpo = null
  if (texto) {
    try {
      cuerpo = JSON.parse(texto)
    } catch {
      cuerpo = texto
    }
  }

  if (!respuesta.ok) {
    if (respuesta.status === 401 && estado.token) {
      cerrarSesionLocal()
      mostrarAuth()
    }
    const error = new Error(mensajeDeError(cuerpo, respuesta.status))
    error.status = respuesta.status
    throw error
  }

  return cuerpo
}

/* ============================ Sesión ============================ */

function guardarSesion(usuario, token, identidad) {
  estado.usuario = usuario
  estado.token = token
  if (identidad) estado.identidad = identidad
  localStorage.setItem(CLAVE_TOKEN, token)
  localStorage.setItem(CLAVE_USUARIO, JSON.stringify(usuario))
  if (estado.identidad) localStorage.setItem(CLAVE_IDENTIDAD, estado.identidad)
}

function cerrarSesionLocal() {
  estado.token = null
  estado.identidad = null
  estado.usuario = null
  estado.tramites = []
  estado.pagos = []
  estado.usuarios = []
  estado.tipos = []
  localStorage.removeItem(CLAVE_TOKEN)
  localStorage.removeItem(CLAVE_IDENTIDAD)
  localStorage.removeItem(CLAVE_USUARIO)
}

function esAdmin() {
  return estado.usuario?.rol === 'admin'
}

/**
 * Tesorería y administración ven todos los datos y confirman pagos; el
 * ciudadano solo ve lo suyo. El servidor vuelve a comprobarlo: esto es solo
 * para no mostrar botones que van a responder 403.
 */
function esPrivilegiado() {
  return esAdmin() || estado.usuario?.rol === 'personal_muni_tesoreria'
}

const NOMBRES_ROL = {
  ciudadano: 'Ciudadano',
  personal_muni_tesoreria: 'Tesorería',
  admin: 'Administrador general',
  servicio: 'Servicio',
}

function nombreRol(rol) {
  return NOMBRES_ROL[rol] || rol || 'Ciudadano'
}

/* ============================ Pantallas ============================ */

function aplicarVisibilidad() {
  $$('.solo-privilegiado').forEach((el) => el.classList.toggle('is-oculto', !esPrivilegiado()))
  $$('.solo-admin').forEach((el) => el.classList.toggle('is-oculto', !esAdmin()))
  $$('[data-campo-privilegiado]').forEach((el) =>
    el.classList.toggle('is-oculto', !esPrivilegiado())
  )
}

function mostrarAuth() {
  $('#pantalla-auth').classList.remove('is-oculto')
  $('#pantalla-app').classList.add('is-oculto')
}

function mostrarApp() {
  $('#pantalla-auth').classList.add('is-oculto')
  $('#pantalla-app').classList.remove('is-oculto')

  const usuario = estado.usuario || {}
  $$('[data-campo="nombre"]').forEach((el) => (el.textContent = usuario.fullName || '—'))
  $$('[data-campo="email"]').forEach((el) => (el.textContent = usuario.email || '—'))
  $$('[data-campo="rol"]').forEach((el) => (el.textContent = nombreRol(usuario.rol)))
  $$('[data-campo="id"]').forEach((el) => (el.textContent = usuario.id ?? '—'))
  $$('[data-campo="creado"]').forEach((el) => (el.textContent = fecha(usuario.createdAt)))
  $$('[data-campo="iniciales"]').forEach(
    (el) => (el.textContent = usuario.initials || iniciales(usuario.fullName, usuario.email))
  )

  $$('.menu__item--admin').forEach((el) => el.classList.toggle('is-oculto', !esAdmin()))
  aplicarVisibilidad()

  cambiarVista('tramites', false)
  pintarCola()
  programarColaSincronizacion()
  cargarDatos()
  setTimeout(() => sincronizarCola({ silencioso: true }), 1000)
}

async function cargarDatos() {
  const tareas = [cargarTramites(), cargarPagos(), cargarTipos()]
  if (esAdmin()) tareas.push(cargarUsuarios())

  const resultados = await Promise.allSettled(tareas)
  const fallo = resultados.find((r) => r.status === 'rejected')
  if (fallo) aviso(fallo.reason.message, 'error')
}

/* ============================ Cola offline ============================ */

let temporizadorCola = null

function actorActual() {
  return estado.usuario?.id ?? null
}

function tipoDeCola(item) {
  const tipo = item.cuerpo?.tipo || 'Trámite'
  return tipo === 'Otro' && item.cuerpo?.tipoDetalle
    ? `Otro: ${item.cuerpo.tipoDetalle}`
    : tipo
}

function pintarCola() {
  const contenedor = $('#cola-tramites')
  if (!contenedor) return

  const actorId = actorActual()
  const items = actorId ? ColaOffline.listar(actorId) : []
  const pendientes = items.filter((item) => item.estado !== 'enviado')
  const enviados = items.filter((item) => item.estado === 'enviado')

  contenedor.classList.toggle('is-oculto', items.length === 0)
  if (!items.length) return

  const conError = pendientes.filter((item) => item.estado === 'error').length
  const enEspera = pendientes.filter((item) => item.estado !== 'error').length
  let resumen = 'Se enviarán automáticamente cuando el servicio vuelva a responder.'

  if (!pendientes.length) {
    resumen = 'No hay pendientes. Abajo quedan los últimos envíos.'
  } else if (conError) {
    resumen = `${enEspera} en espera y ${conError} con error. Revisa el detalle o descarta los que no sirvan.`
  } else {
    resumen = `${enEspera} pendiente(s) de envío. Se reintentará automáticamente.`
  }

  $('#cola-resumen').textContent = resumen
  $('#cola-reintentar').disabled = !pendientes.some(
    (item) => item.estado === 'pendiente' || item.estado === 'enviando'
  )

  $('#cola-lista').innerHTML = pendientes.length
    ? pendientes
        .map((item) => {
          const etiqueta =
            item.estado === 'error' ? 'error' : item.estado === 'enviando' ? 'enviando' : 'pendiente'
          const detalle = item.ultimoError
            ? `<p class="aviso-error">${esc(item.ultimoError)}</p>`
            : '<p class="tenue">Esperando conexión con el servicio.</p>'
          const botones =
            item.estado === 'enviando'
              ? ''
              : `<button class="boton boton--secundario boton--pequeno" type="button"
                         data-cola-reintentar="${esc(item.id)}">Reintentar</button>
                 <button class="boton boton--fantasma boton--pequeno" type="button"
                         data-cola-descartar="${esc(item.id)}">Descartar</button>`

          return `<li class="cola__item">
            <div>
              <strong>${esc(tipoDeCola(item))}</strong>
              <span class="etiqueta etiqueta--${etiqueta}">${esc(etiqueta)}</span>
              <p class="tenue">
                Solicitado ${fecha(item.creadoClienteEn || item.encoladoEn)}
                · ${item.intentos} intento(s)
              </p>
              ${detalle}
            </div>
            <div class="cola__acciones">${botones}</div>
          </li>`
        })
        .join('')
    : '<li class="tenue">No hay trámites esperando envío.</li>'

  const historial = $('#cola-historial-envoltura')
  historial.classList.toggle('is-oculto', !enviados.length)
  $('#cola-historial').innerHTML = enviados
    .slice(-8)
    .reverse()
    .map(
      (item) => `<li class="cola__item">
        <div>
          <strong>${esc(tipoDeCola(item))}</strong>
          <span class="etiqueta etiqueta--pagado">enviado</span>
          <p class="tenue">
            ${item.respuestaId ? `Registrado como ${esc(item.respuestaId)} · ` : ''}
            ${fecha(item.enviadoEn)}
          </p>
        </div>
      </li>`
    )
    .join('')
}

async function sincronizarCola({ silencioso = true, forzar = false } = {}) {
  const actorId = actorActual()
  if (!actorId || !estado.identidad) return null
  if (!ColaOffline.pendientes(actorId).length) {
    pintarCola()
    return null
  }

  const resultado = await ColaOffline.sincronizar({
    actorId,
    enviar: (item) =>
      api(item.ruta, {
        method: item.metodo,
        body: JSON.stringify(item.cuerpo),
        headers: {
          'Idempotency-Key': item.id,
          'X-Origen': 'offline',
        },
      }),
    alCambiar: pintarCola,
    forzar,
  }).catch((error) => {
    if (!silencioso) aviso(error.message, 'error')
    return null
  })

  pintarCola()

  if (resultado?.enviados) {
    aviso(`Se enviaron ${resultado.enviados} trámite(s) pendiente(s).`, 'ok')

    try {
      await cargarTramites()
    } catch (error) {
      if (!silencioso) aviso(error.message, 'error')
    }
  } else if (!silencioso && resultado?.fallidos) {
    aviso('No se pudieron enviar todos los pendientes. Se reintentará.', 'error')
  }

  return resultado
}

function programarColaSincronizacion() {
  if (temporizadorCola) return

  temporizadorCola = setInterval(() => {
    if (document.visibilityState !== 'visible') return
    sincronizarCola({ silencioso: true })
  }, 20000)
}

/* ============================ Vistas ============================ */

const TEXTOS_VISTA = {
  tramites: {
    titulo: 'Trámites',
    subtitulo: 'Solicitudes registradas en el sistema.',
    accion: 'Nuevo trámite',
  },
  pagos: {
    titulo: 'Pagos',
    subtitulo: 'Pagos registrados y su vínculo con los trámites.',
    accion: 'Nuevo pago',
  },
  cuenta: {
    titulo: 'Mi cuenta',
    subtitulo: 'Datos de tu sesión.',
    accion: null,
  },
  usuarios: {
    titulo: 'Usuarios',
    subtitulo: 'Cuentas registradas en el servicio de usuarios.',
    accion: null,
  },
  administracion: {
    titulo: 'Administración',
    subtitulo: 'Resumen del sistema y catálogo de trámites.',
    accion: null,
  },
}

function cambiarVista(vista, refrescar = true) {
  if (!TEXTOS_VISTA[vista]) return
  if ((vista === 'usuarios' || vista === 'administracion') && !esAdmin()) return

  estado.vista = vista

  $$('.menu__item[data-vista]').forEach((boton) => {
    boton.classList.toggle('is-activo', boton.dataset.vista === vista)
  })
  $$('.vista[data-vista]').forEach((seccion) => {
    seccion.classList.toggle('is-activa', seccion.dataset.vista === vista)
  })

  const textos = TEXTOS_VISTA[vista]
  $('#titulo-vista').textContent = textos.titulo
  $('#subtitulo-vista').textContent = textos.subtitulo

  const botonNuevo = $('#boton-nuevo')
  botonNuevo.classList.toggle('is-oculto', !textos.accion)
  if (textos.accion) botonNuevo.textContent = textos.accion

  ocultarFormularios()

  if (!refrescar) {
    if (vista === 'administracion') actualizarMetricas()
    return
  }

  if (vista === 'pagos') cargarPagos().catch((e) => aviso(e.message, 'error'))
  if (vista === 'tramites') cargarTramites().catch((e) => aviso(e.message, 'error'))
  if (vista === 'usuarios') cargarUsuarios().catch((e) => aviso(e.message, 'error'))
  if (vista === 'administracion') {
    cargarTipos().catch((e) => aviso(e.message, 'error'))
    actualizarMetricas()
  }
}

function ocultarFormularios() {
  $('#form-tramite').classList.add('is-oculto')
  $('#form-pago').classList.add('is-oculto')
}

/* ============================ Datos y tablas ============================ */

async function cargarTramites() {
  estado.tramites = (await api('/api/v1/tramites')) || []
  pintarTramites()
  actualizarMetricas()
}

async function cargarPagos() {
  estado.pagos = (await api('/api/v1/pagos')) || []
  pintarPagos()
  actualizarMetricas()
}

async function cargarUsuarios() {
  if (!esAdmin()) return
  estado.usuarios = (await api('/api/v1/usuarios')) || []
  pintarUsuarios()
  actualizarMetricas()
}

async function cargarTipos() {
  estado.tipos = (await api('/api/v1/tipos-tramite')) || []
  poblarSelectTipos()
  pintarTipos()
}

function actualizarMetricas() {
  const metricas = {
    usuarios: estado.usuarios.length,
    tramites: estado.tramites.length,
    pagos: estado.pagos.length,
  }
  $$('[data-metrica]').forEach((el) => {
    el.textContent = metricas[el.dataset.metrica] ?? '—'
  })
}

function filaVacia(columnas, texto) {
  return `<tr><td class="celda-vacia" colspan="${columnas}">${esc(texto)}</td></tr>`
}

function pintarTramites() {
  const cuerpo = $('#tabla-tramites')
  if (!estado.tramites.length) {
    cuerpo.innerHTML = filaVacia(9, 'Todavía no hay trámites registrados.')
    aplicarVisibilidad()
    return
  }

  cuerpo.innerHTML = estado.tramites
    .map((t) => {
      const estadoTramite = t.estado || 'pendiente'
      const tipo = t.tipo === 'Otro' && t.tipoDetalle ? `Otro: ${t.tipoDetalle}` : t.tipo
      const acciones = esAdmin()
        ? `<button class="boton boton--secundario boton--pequeno" type="button"
                   data-editar-tramite="${esc(t.id)}">Editar</button>
           <button class="boton boton--fantasma boton--pequeno" type="button"
                   data-eliminar-tramite="${esc(t.id)}">Eliminar</button>`
        : '—'

      return `
      <tr>
        <td class="mono">${esc(t.id)}</td>
        <td class="mono">${esc(t.usuarioId)}</td>
        <td>${esc(tipo)}</td>
        <td>
          ${esc(t.descripcion)}
          ${t.origen === 'offline' ? '<span class="etiqueta etiqueta--offline">offline</span>' : ''}
          ${
            t.creadoClienteEn
              ? `<span class="tramite__meta">Solicitado ${fecha(t.creadoClienteEn)} · Registrado ${fecha(t.createdAt)}</span>`
              : ''
          }
        </td>
        <td class="mono">${dinero(t.monto)}</td>
        <td><span class="etiqueta etiqueta--${esc(estadoTramite)}">${esc(estadoTramite)}</span></td>
        <td class="mono solo-privilegiado">${esc(t.lamport ?? '—')}</td>
        <td class="solo-privilegiado">${esc(t.nodeId ?? '—')}</td>
        <td class="solo-admin">${acciones}</td>
      </tr>`
    })
    .join('')

  aplicarVisibilidad()
}

function pintarPagos() {
  const cuerpo = $('#tabla-pagos')
  if (!estado.pagos.length) {
    cuerpo.innerHTML = filaVacia(9, 'Todavía no hay pagos registrados.')
    aplicarVisibilidad()
    return
  }

  cuerpo.innerHTML = estado.pagos
    .map(
      (p) => `
      <tr>
        <td class="mono">${esc(p.idPago)}</td>
        <td class="mono">${esc(p.idTramite)}</td>
        <td class="mono">${esc(p.usuarioId ?? '—')}</td>
        <td class="mono">${dinero(p.monto)}</td>
        <td>${esc(p.metodoPago)}</td>
        <td>${fecha(p.fechaPago)}</td>
        <td><span class="etiqueta etiqueta--${esc(p.estado)}">${esc(p.estado)}</span></td>
        <td class="mono solo-privilegiado">${esc(p.lamport ?? '—')}</td>
        <td>${
          esPrivilegiado() && p.estado === 'pendiente'
            ? `<button class="boton boton--secundario boton--pequeno" type="button" data-confirmar="${esc(p.idPago)}">Confirmar</button>`
            : '—'
        }</td>
      </tr>`
    )
    .join('')

  aplicarVisibilidad()
}

function pintarUsuarios() {
  const cuerpo = $('#tabla-usuarios')
  if (!estado.usuarios.length) {
    cuerpo.innerHTML = filaVacia(5, 'No hay usuarios registrados.')
    return
  }

  cuerpo.innerHTML = estado.usuarios
    .map(
      (u) => `
      <tr>
        <td class="mono">${esc(u.id)}</td>
        <td>${esc(u.fullName || '—')}</td>
        <td>${esc(u.email)}</td>
        <td><span class="etiqueta etiqueta--${esc(u.rol)}">${esc(nombreRol(u.rol))}</span></td>
        <td>${fecha(u.createdAt)}</td>
      </tr>`
    )
    .join('')
}

function pintarTipos() {
  const cuerpo = $('#tabla-tipos')
  if (!cuerpo) return

  if (!estado.tipos.length) {
    cuerpo.innerHTML = filaVacia(5, 'No hay tipos de trámite registrados.')
    return
  }

  cuerpo.innerHTML = estado.tipos
    .map(
      (t) => `
      <tr>
        <td class="mono">${esc(t.id)}</td>
        <td>${esc(t.nombre)}</td>
        <td class="mono">${dinero(t.monto)}</td>
        <td>${t.activo ? 'Sí' : 'No'}</td>
        <td>
          <button class="boton boton--secundario boton--pequeno" type="button"
                  data-editar-tipo="${esc(t.id)}">Editar</button>
          <button class="boton boton--fantasma boton--pequeno" type="button"
                  data-eliminar-tipo="${esc(t.id)}">Eliminar</button>
        </td>
      </tr>`
    )
    .join('')
}

function poblarSelectTipos() {
  const select = $('#tramite-tipo')
  if (!select) return

  const actual = select.value
  const fijos = estado.tipos
    .filter((t) => t.activo)
    .map((t) => `<option value="${esc(t.nombre)}">${esc(t.nombre)} (${dinero(t.monto)})</option>`)
    .join('')

  select.innerHTML = `<option value="">Selecciona un tipo…</option>${fijos}<option value="Otro">Otro</option>`

  if (actual) select.value = actual
}

/* ============================ Formulario de trámite ============================ */

function actualizarMontoTramite() {
  const select = $('#tramite-tipo')
  const monto = $('#tramite-monto')
  const detalle = $('#campo-tipo-detalle')
  const ayuda = $('#tramite-monto-ayuda')
  const tipo = select.value

  if (tipo === 'Otro') {
    detalle.classList.remove('is-oculto')
    monto.readOnly = false
    monto.value = ''
    ayuda.textContent = 'Indica el monto a cobrar por este trámite.'
    return
  }

  detalle.classList.add('is-oculto')
  monto.readOnly = true

  const encontrado = estado.tipos.find((t) => t.nombre === tipo)
  monto.value = encontrado ? Number(encontrado.monto).toFixed(2) : ''
  ayuda.textContent = 'Lo fija el tipo seleccionado.'
}

function abrirFormularioTramite() {
  const formulario = $('#form-tramite')
  formulario.reset()
  estado.tramiteEditando = null
  estado.versionEditando = null
  $('#tramite-titulo').textContent = 'Registrar un trámite'
  formulario.querySelector('button[type="submit"]').textContent = 'Registrar trámite'
  formulario.elements.usuarioId.disabled = false
  formulario.elements.usuarioId.closest('.campo').classList.remove('is-oculto')
  formulario.elements.usuarioId.value = estado.usuario?.id ?? ''
  poblarSelectTipos()
  actualizarMontoTramite()
  formulario.classList.remove('is-oculto')
  formulario.elements.tipo.focus()
}

function abrirEdicionTramite(tramite) {
  const formulario = $('#form-tramite')
  formulario.reset()
  estado.tramiteEditando = tramite.id
  estado.versionEditando = tramite.version ?? null
  $('#tramite-titulo').textContent = `Editar trámite ${tramite.id}`
  formulario.querySelector('button[type="submit"]').textContent = 'Guardar cambios'
  formulario.elements.usuarioId.closest('.campo').classList.add('is-oculto')
  poblarSelectTipos()
  formulario.elements.tipo.value = tramite.tipo
  actualizarMontoTramite()
  formulario.elements.descripcion.value = tramite.descripcion ?? ''
  formulario.elements.monto.value = Number(tramite.monto).toFixed(2)
  if (tramite.tipo === 'Otro') {
    formulario.elements.tipoDetalle.value = tramite.tipoDetalle ?? ''
    formulario.elements.monto.readOnly = false
  }
  formulario.classList.remove('is-oculto')
  formulario.elements.tipo.focus()
}

/* ============================ Autenticación ============================ */

function cambiarPestana(cual) {
  $$('.pestana').forEach((p) => {
    const activa = p.dataset.auth === cual
    p.classList.toggle('is-activa', activa)
    p.setAttribute('aria-selected', String(activa))
  })
  $('#form-login').classList.toggle('is-oculto', cual !== 'login')
  $('#form-registro').classList.toggle('is-oculto', cual !== 'registro')
}

function conBotonOcupado(boton, accion) {
  const texto = boton.textContent
  boton.disabled = true
  boton.textContent = 'Procesando…'
  return Promise.resolve()
    .then(accion)
    .finally(() => {
      boton.disabled = false
      boton.textContent = texto
    })
}

/* ============================ Eventos ============================ */

function registrarEventos() {
  $$('.pestana[data-auth]').forEach((pestana) => {
    pestana.addEventListener('click', () => cambiarPestana(pestana.dataset.auth))
  })

  window.addEventListener('online', () => sincronizarCola({ silencioso: true }))

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sincronizarCola({ silencioso: true })
  })

  $('#cola-reintentar').addEventListener('click', () =>
    sincronizarCola({ silencioso: false, forzar: true })
  )

  $('#cola-tramites').addEventListener('click', async (evento) => {
    const reintentar = evento.target.closest('[data-cola-reintentar]')
    const descartar = evento.target.closest('[data-cola-descartar]')

    if (reintentar) {
      ColaOffline.reintentar(reintentar.dataset.colaReintentar)
      pintarCola()
      await sincronizarCola({ silencioso: false })
      return
    }

    if (!descartar) return

    if (!window.confirm('¿Descartar este trámite pendiente? No se enviará al municipio.')) return

    ColaOffline.eliminar(descartar.dataset.colaDescartar)
    pintarCola()
  })

  $('#form-login').addEventListener('submit', async (evento) => {
    evento.preventDefault()
    const formulario = evento.currentTarget
    const avisoError = $('[data-error="login"]')
    avisoError.textContent = ''

    const datos = new FormData(formulario)
    const boton = formulario.querySelector('button[type="submit"]')

    try {
      await conBotonOcupado(boton, async () => {
        const respuesta = desenvolver(
          await api('/api/v1/auth/login', {
            method: 'POST',
            body: JSON.stringify({
              email: String(datos.get('email')).trim(),
              password: String(datos.get('password')),
            }),
          })
        )
        guardarSesion(respuesta.user, respuesta.token, respuesta.identidad)
        formulario.reset()
        mostrarApp()
        aviso(`Bienvenido, ${respuesta.user.fullName || respuesta.user.email}.`, 'ok')
      })
    } catch (error) {
      if (!(error.status === 401 && !estado.token)) {
        avisoError.textContent = error.message
      } else {
        avisoError.textContent = 'Correo o contraseña incorrectos.'
      }
    }
  })

  $('#form-registro').addEventListener('submit', async (evento) => {
    evento.preventDefault()
    const formulario = evento.currentTarget
    const avisoError = $('[data-error="registro"]')
    avisoError.textContent = ''

    const datos = new FormData(formulario)
    const password = String(datos.get('password'))
    const confirmacion = String(datos.get('passwordConfirmation'))

    if (password !== confirmacion) {
      avisoError.textContent = 'Las contraseñas no coinciden.'
      return
    }

    const boton = formulario.querySelector('button[type="submit"]')

    try {
      await conBotonOcupado(boton, async () => {
        const respuesta = desenvolver(
          await api('/api/v1/auth/signup', {
            method: 'POST',
            body: JSON.stringify({
              dni: String(datos.get('dni')).trim(),
              fullName: String(datos.get('fullName')).trim(),
              email: String(datos.get('email')).trim(),
              password,
              passwordConfirmation: confirmacion,
            }),
          })
        )
        guardarSesion(respuesta.user, respuesta.token, respuesta.identidad)
        formulario.reset()
        mostrarApp()
        aviso('Tu cuenta fue creada correctamente.', 'ok')
      })
    } catch (error) {
      avisoError.textContent = error.message
    }
  })

  $$('.menu__item[data-vista]').forEach((boton) => {
    boton.addEventListener('click', () => cambiarVista(boton.dataset.vista))
  })

  // Delegado en el tbody: las filas se vuelven a pintar tras cada carga.
  $('#tabla-pagos').addEventListener('click', async (evento) => {
    const boton = evento.target.closest('[data-confirmar]')
    if (!boton) return

    const id = boton.dataset.confirmar
    boton.disabled = true
    boton.textContent = 'Confirmando…'

    try {
      await api(`/api/v1/pagos/${encodeURIComponent(id)}/confirmar`, { method: 'POST' })
      await Promise.all([cargarPagos(), cargarTramites()])
      aviso('Pago confirmado: el trámite quedó acreditado.', 'ok')
    } catch (error) {
      aviso(error.message, 'error')
      boton.disabled = false
      boton.textContent = 'Confirmar'
    }
  })

  // Editar / eliminar trámites (solo admin).
  $('#tabla-tramites').addEventListener('click', async (evento) => {
    const editar = evento.target.closest('[data-editar-tramite]')
    const eliminar = evento.target.closest('[data-eliminar-tramite]')

    if (editar) {
      const tramite = estado.tramites.find((t) => t.id === editar.dataset.editarTramite)
      if (tramite) abrirEdicionTramite(tramite)
      return
    }

    if (!eliminar) return

    const id = eliminar.dataset.eliminarTramite
    if (!window.confirm(`¿Eliminar el trámite ${id}? Esta acción no se puede deshacer.`)) return

    try {
      await api(`/api/v1/tramites/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await cargarTramites()
      aviso('Trámite eliminado.', 'ok')
    } catch (error) {
      aviso(error.message, 'error')
    }
  })

  $('#boton-salir').addEventListener('click', async () => {
    try {
      await api('/api/v1/account/logout', { method: 'POST' })
    } catch {
      // La sesión local se cierra igual: el token puede haber caducado ya.
    }
    cerrarSesionLocal()
    mostrarAuth()
    aviso('Sesión cerrada.')
  })

  $('#boton-nuevo').addEventListener('click', () => {
    if (estado.vista === 'tramites') {
      const formulario = $('#form-tramite')
      const visible = !formulario.classList.contains('is-oculto')
      ocultarFormularios()
      if (visible) return
      abrirFormularioTramite()
    }

    if (estado.vista === 'pagos') {
      const formulario = $('#form-pago')
      const visible = !formulario.classList.contains('is-oculto')
      ocultarFormularios()
      if (visible) return

      formulario.reset()
      const ahora = new Date()
      const local = new Date(ahora.getTime() - ahora.getTimezoneOffset() * 60000)
      formulario.elements.fecha_pago.value = local.toISOString().slice(0, 16)
      formulario.elements.usuario_id.value = estado.usuario?.id ?? ''
      formulario.classList.remove('is-oculto')
      formulario.elements.id_tramite.focus()
    }
  })

  $$('[data-cancelar]').forEach((boton) => {
    boton.addEventListener('click', () => {
      estado.tramiteEditando = null
      estado.versionEditando = null
      ocultarFormularios()
    })
  })

  $('#tramite-tipo').addEventListener('change', actualizarMontoTramite)

  $('#form-tramite').addEventListener('submit', async (evento) => {
    evento.preventDefault()
    const formulario = evento.currentTarget
    const avisoError = $('[data-error="tramite"]')
    avisoError.textContent = ''
    const datos = new FormData(formulario)
    const boton = formulario.querySelector('button[type="submit"]')
    const tipo = String(datos.get('tipo'))

    const cuerpo = {
      tipo,
      tipoDetalle: tipo === 'Otro' ? String(datos.get('tipoDetalle')).trim() : undefined,
      descripcion: String(datos.get('descripcion')).trim(),
      monto: Number(datos.get('monto')),
    }

    try {
      await conBotonOcupado(boton, async () => {
        if (estado.tramiteEditando) {
          const cambios =
            estado.versionEditando === null
              ? cuerpo
              : { ...cuerpo, version: estado.versionEditando }
          await api(`/api/v1/tramites/${encodeURIComponent(estado.tramiteEditando)}`, {
            method: 'PATCH',
            body: JSON.stringify(cambios),
          })
          aviso('Trámite actualizado.', 'ok')
        } else {
          const actorId = estado.usuario?.id
          const usuarioId = esPrivilegiado()
            ? String(datos.get('usuarioId')).trim()
            : actorId
          const creadoClienteEn = new Date().toISOString()
          const clave = ColaOffline.nuevaClave()
          const datosEnvio = { ...cuerpo, usuarioId, creadoClienteEn }

          try {
            await api('/api/v1/tramites', {
              method: 'POST',
              body: JSON.stringify(datosEnvio),
              headers: { 'Idempotency-Key': clave },
            })
            aviso('Trámite registrado.', 'ok')
          } catch (error) {
            // Solo se encola lo que tiene sentido reintentar: red, 502/503/504
            // o errores transitorios. Un 400/403 es un dato inválido y se le
            // muestra al usuario para que lo corrija.
            if (!actorId || !ColaOffline.esReintentable(error.status)) throw error

            await ColaOffline.encolar({
              id: clave,
              actorId,
              usuarioId,
              ruta: '/api/v1/tramites',
              metodo: 'POST',
              cuerpo: datosEnvio,
              creadoClienteEn,
            })

            estado.tramiteEditando = null
            estado.versionEditando = null
            formulario.reset()
            ocultarFormularios()
            pintarCola()
            programarColaSincronizacion()
            aviso(
              'El servicio no está disponible. El trámite quedó en pendientes y se enviará automáticamente.',
              'error'
            )
            return
          }
        }

        estado.tramiteEditando = null
        estado.versionEditando = null
        formulario.reset()
        ocultarFormularios()
        await cargarTramites()
      })
    } catch (error) {
      avisoError.textContent = error.message
    }
  })

  $('#form-pago').addEventListener('submit', async (evento) => {
    evento.preventDefault()
    const formulario = evento.currentTarget
    const avisoError = $('[data-error="pago"]')
    avisoError.textContent = ''
    const datos = new FormData(formulario)
    const boton = formulario.querySelector('button[type="submit"]')

    const fechaLocal = String(datos.get('fecha_pago'))
    const fechaIso = fechaLocal ? new Date(fechaLocal).toISOString() : new Date().toISOString()

    try {
      await conBotonOcupado(boton, async () => {
        await api('/api/v1/pagos', {
          method: 'POST',
          body: JSON.stringify({
            id_tramite: String(datos.get('id_tramite')).trim(),
            usuario_id: esPrivilegiado()
              ? String(datos.get('usuario_id')).trim()
              : estado.usuario?.id,
            monto: Number(datos.get('monto')),
            metodo_pago: String(datos.get('metodo_pago')),
            fecha_pago: fechaIso,
          }),
        })
        formulario.reset()
        ocultarFormularios()
        await Promise.all([cargarPagos(), cargarTramites()])
        aviso('Solicitud de pago registrada. Queda pendiente de confirmación.', 'ok')
      })
    } catch (error) {
      avisoError.textContent = error.message
    }
  })

  // --- Crear usuario (solo admin) ---
  $('#boton-nuevo-usuario').addEventListener('click', () => {
    const formulario = $('#form-usuario')
    const visible = !formulario.classList.contains('is-oculto')
    formulario.reset()
    formulario.classList.toggle('is-oculto', visible)
    if (!visible) formulario.elements.dni.focus()
  })

  $('[data-cancelar-usuario]').addEventListener('click', () => {
    $('#form-usuario').classList.add('is-oculto')
  })

  $('#form-usuario').addEventListener('submit', async (evento) => {
    evento.preventDefault()
    const formulario = evento.currentTarget
    const avisoError = $('[data-error="usuario"]')
    avisoError.textContent = ''
    const datos = new FormData(formulario)
    const password = String(datos.get('password'))
    const confirmacion = String(datos.get('passwordConfirmation'))

    if (password !== confirmacion) {
      avisoError.textContent = 'Las contraseñas no coinciden.'
      return
    }

    const boton = formulario.querySelector('button[type="submit"]')

    try {
      await conBotonOcupado(boton, async () => {
        await api('/api/v1/admin/usuarios', {
          method: 'POST',
          body: JSON.stringify({
            dni: String(datos.get('dni')).trim(),
            fullName: String(datos.get('fullName')).trim(),
            email: String(datos.get('email')).trim(),
            password,
            passwordConfirmation: confirmacion,
            rol: String(datos.get('rol')),
          }),
        })
        formulario.reset()
        formulario.classList.add('is-oculto')
        await cargarUsuarios()
        aviso('Usuario creado correctamente.', 'ok')
      })
    } catch (error) {
      avisoError.textContent = error.message
    }
  })

  // --- Catálogo de tipos de trámite (solo admin) ---
  $('#form-tipo').addEventListener('submit', async (evento) => {
    evento.preventDefault()
    const formulario = evento.currentTarget
    const avisoError = $('[data-error="tipo"]')
    avisoError.textContent = ''
    const datos = new FormData(formulario)
    const boton = formulario.querySelector('button[type="submit"]')

    try {
      await conBotonOcupado(boton, async () => {
        await api('/api/v1/tipos-tramite', {
          method: 'POST',
          body: JSON.stringify({
            nombre: String(datos.get('nombre')).trim(),
            monto: Number(datos.get('monto')),
          }),
        })
        formulario.reset()
        await cargarTipos()
        aviso('Tipo de trámite agregado.', 'ok')
      })
    } catch (error) {
      avisoError.textContent = error.message
    }
  })

  $('#tabla-tipos').addEventListener('click', async (evento) => {
    const editar = evento.target.closest('[data-editar-tipo]')
    const eliminar = evento.target.closest('[data-eliminar-tipo]')

    if (editar) {
      const tipo = estado.tipos.find((t) => String(t.id) === editar.dataset.editarTipo)
      if (!tipo) return

      const nombre = window.prompt('Nombre del tipo', tipo.nombre)
      if (nombre === null) return

      const montoTexto = window.prompt('Monto', String(tipo.monto))
      if (montoTexto === null) return

      try {
        await api(`/api/v1/tipos-tramite/${encodeURIComponent(tipo.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ nombre: nombre.trim(), monto: Number(montoTexto) }),
        })
        await cargarTipos()
        aviso('Tipo actualizado.', 'ok')
      } catch (error) {
        aviso(error.message, 'error')
      }
      return
    }

    if (!eliminar) return

    const tipo = estado.tipos.find((t) => String(t.id) === eliminar.dataset.eliminarTipo)
    if (!tipo) return

    if (!window.confirm(`¿Eliminar el tipo "${tipo.nombre}"?`)) return

    try {
      await api(`/api/v1/tipos-tramite/${encodeURIComponent(tipo.id)}`, { method: 'DELETE' })
      await cargarTipos()
      aviso('Tipo eliminado.', 'ok')
    } catch (error) {
      aviso(error.message, 'error')
    }
  })
}

/* ============================ Arranque ============================ */

async function iniciar() {
  registrarEventos()

  if (!estado.token) {
    mostrarAuth()
    return
  }

  try {
    const perfil = desenvolver(await api('/api/v1/account/profile'))
    guardarSesion(perfil.user, estado.token, perfil.identidad)
    mostrarApp()
  } catch (error) {
    if (error.status === 401) {
      cerrarSesionLocal()
      mostrarAuth()
      return
    }

    // Si el servicio no responde pero hay sesión guardada, se entra igual: la
    // interfaz sigue siendo útil y los errores se muestran al pedir los datos.
    if (estado.usuario) {
      mostrarApp()
      aviso(`No se pudo validar la sesión: ${error.message}`, 'error')
      return
    }

    mostrarAuth()
    aviso(error.message, 'error')
  }
}

document.addEventListener('DOMContentLoaded', iniciar)
