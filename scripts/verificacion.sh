#!/usr/bin/env bash
#
# Verificación automática de los tres puntos del informe.
#
#   1. El sistema actúa cuando falla el servidor principal
#   2. Los datos se mantienen consistentes al registrar usuarios, trámites y pagos
#   3. El sistema se recupera ante fallos
#
# Cada comprobación imprime PASS o FAIL y al final hay un resumen. Está pensado
# para ejecutarse delante del profesor y capturar la salida.
#
# Es rápido y NO destructivo con los datos: solo apaga y levanta contenedores, y
# crea sus propios datos de prueba.
#
#   ./scripts/verificacion.sh
#
# Las demostraciones largas (PITR y el fallo inyectado) están aparte, porque
# modifican datos a propósito:
#   ./scripts/recuperacion.sh demo-backup
#   ./scripts/recuperacion.sh saga

set -uo pipefail

cd "$(dirname "$0")/.."

BASE="http://localhost:8080"
TRAMITES=(tramites_1 tramites_2)
USUARIOS=(usuarios_1 usuarios_2)

# Identidad firmada que se obtiene al entrar como administrador. Trámites,
# pagos y el listado de usuarios la exigen; sin ella responderían 401.
IDENTIDAD=""
USUARIO_ID="10000001"

VERDE=$'\033[0;32m'
ROJO=$'\033[0;31m'
AMBAR=$'\033[0;33m'
GRIS=$'\033[0;90m'
NEGRITA=$'\033[1m'
FIN=$'\033[0m'

TOTAL=0
PASADOS=0
FALLIDOS=0

titulo() {
  printf '\n%s%s%s\n' "$NEGRITA" "$(printf '=%.0s' $(seq 1 74))" "$FIN"
  printf '%s %s%s\n' "$NEGRITA" "$1" "$FIN"
  printf '%s%s%s\n' "$NEGRITA" "$(printf '=%.0s' $(seq 1 74))" "$FIN"
}

sub() { printf '\n%s%s%s\n' "$NEGRITA" "$1" "$FIN"; }
nota() { printf '   %s%s%s\n' "$GRIS" "$1" "$FIN"; }

# check <descripción> <código esperado> <código obtenido>
check() {
  local desc="${1:-?}" esperado="${2:-?}" obtenido="${3:-?}"
  TOTAL=$((${TOTAL:-0} + 1))
  if [ "$esperado" = "$obtenido" ]; then
    PASADOS=$((${PASADOS:-0} + 1))
    printf '   %sPASS%s  %-52s %s\n' "$VERDE" "$FIN" "$desc" "$obtenido"
  else
    FALLIDOS=$((FALLIDOS + 1))
    printf '   %sFAIL%s  %-52s esperado %s, obtenido %s\n' "$ROJO" "$FIN" "$desc" "$esperado" "$obtenido"
  fi
}

# check_txt <descripción> <texto esperado> <valor>
check_txt() {
  local desc="${1:-?}" esperado="${2:-?}" valor="${3:-?}"
  TOTAL=$((${TOTAL:-0} + 1))
  if [ "$esperado" = "$valor" ]; then
    PASADOS=$((${PASADOS:-0} + 1))
    printf '   %sPASS%s  %-52s %s\n' "$VERDE" "$FIN" "$desc" "$valor"
  else
    FALLIDOS=$((${FALLIDOS:-0} + 1))
    printf '   %sFAIL%s  %-52s esperado "%s", obtenido "%s"\n' "$ROJO" "$FIN" "$desc" "$esperado" "$valor"
  fi
}

codigo() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

# login <correo> <contraseña> -> cuerpo JSON de /auth/login
login() {
  curl -s --max-time 20 -X POST "$BASE/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}"
}

# sql <base> <consulta>
sql() {
  docker compose exec -T postgres psql -U municipalidad -d "$1" -tAc "$2" 2>/dev/null | tr -d '\r'
}

# Los ids de usuario son el DNI (8 dígitos). Se genera uno distinto por corrida
# para no chocar con los usuarios de pruebas anteriores.
nuevo_dni() {
  printf '9%07d' "$(( (RANDOM * 32768 + RANDOM) % 10000000 ))"
}

esperar_puerto_gw() {
  local segundos="${1:-90}" i
  for ((i = 0; i < segundos; i += 2)); do
    [ "$(codigo "$BASE/health")" = "200" ] && return 0
    sleep 2
  done
  return 1
}

esperar_puerto() {
  local puerto="$1" segundos="${2:-60}" i
  for ((i = 0; i < segundos; i += 2)); do
    [ "$(codigo "http://localhost:$puerto/")" = "200" ] && return 0
    sleep 2
  done
  return 1
}

trap 'docker compose unpause "${TRAMITES[@]}" >/dev/null 2>&1; docker compose up -d >/dev/null 2>&1' EXIT INT TERM

# ============================================================ PUNTO 1

punto1() {
  titulo "PUNTO 1 — El sistema actúa cuando falla el servidor principal"

  local sesion
  sesion=$(login admin@municipalidad.gob Municipal123)
  IDENTIDAD=$(printf '%s' "$sesion" | jq -r '.data.identidad // empty')
  USUARIO_ID=$(printf '%s' "$sesion" | jq -r '.data.user.id // "10000001"')

  sub "1.1  Estado base"
  check "gateway /health responde" "200" "$(codigo "$BASE/health")"
  check "GET /api/v1/tramites responde" "200" \
    "$(codigo -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites")"

  sub "1.2  Una réplica de tramites cae (el servicio sigue)"
  docker compose stop tramites_2 >/dev/null 2>&1
  sleep 2
  check "GET /tramites con 1 réplica caída" "200" \
    "$(codigo -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites")"
  check "POST /tramites con 1 réplica caída" "201" \
    "$(codigo -X POST "$BASE/api/v1/tramites" \
       -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d "{\"usuarioId\":\"$USUARIO_ID\",\"tipo\":\"Otro\",\"tipoDetalle\":\"verificacion\",\"monto\":1000,\"descripcion\":\"punto1\"}")"
  docker compose start tramites_2 >/dev/null 2>&1
  esperar_puerto 3334 60
  nota "   El gateway reparte el tráfico entre las dos réplicas."

  sub "1.3  El servicio completo de tramites cae"
  docker compose stop "${TRAMITES[@]}" >/dev/null 2>&1
  sleep 2
  check "GET /tramites con el servicio caído" "504" \
    "$(codigo -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites")"
  check "el gateway sigue vivo (/health)" "200" "$(codigo "$BASE/health")"
  check_txt "no devuelve 200, no finge que funciona" "no-200" \
    "$([ "$(codigo -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites")" != "200" ] && echo "no-200" || echo "200")"
  nota "   504 y no 500: el gateway sabe que no puede, en vez de propagar un error confuso."

  sub "1.4  Recuperación del servicio"
  docker compose up -d >/dev/null 2>&1
  esperar_puerto 3333 60
  esperar_puerto 3334 60
  check "GET /tramites tras volver el servicio" "200" \
    "$(codigo -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites")"
}

# ============================================================ PUNTO 2

punto2() {
  titulo "PUNTO 2 — Consistencia de datos al registrar usuarios, trámites y pagos"

  # Si se ejecuta suelto, se obtiene la identidad de administrador aquí.
  if [ -z "$IDENTIDAD" ]; then
    local sesion
    sesion=$(login admin@municipalidad.gob Municipal123)
    IDENTIDAD=$(printf '%s' "$sesion" | jq -r '.data.identidad // empty')
  fi

  # Se necesita un usuario para el resto de comprobaciones.
  local usuario_id
  usuario_id=$(curl -s -X POST "$BASE/api/v1/usuarios" -H 'Content-Type: application/json' \
    -d "{\"dni\":\"$(nuevo_dni)\",\"email\":\"verif$(date +%s)@mun.test\",\"password\":\"secreto123\",\"fullName\":\"Verificacion\",\"passwordConfirmation\":\"secreto123\"}" \
    | jq -r '.data.user.id' 2>/dev/null)
  [ -z "$usuario_id" ] || [ "$usuario_id" = "null" ] && usuario_id=10000001

  sub "2.1  Validación del usuario (no se confía en el cliente)"
  check "trámite con usuario inexistente" "400" \
    "$(codigo -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d '{"usuarioId":"99999999","tipo":"Otro","tipoDetalle":"verificacion","monto":1000,"descripcion":"x"}')"
  check "trámite sin usuarioId" "400" \
    "$(codigo -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d '{"tipo":"Otro","tipoDetalle":"verificacion","monto":1000,"descripcion":"x"}')"
  check "trámite con usuario válido" "201" \
    "$(codigo -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"verificacion\",\"monto\":1000,\"descripcion\":\"punto2\"}")"

  sub "2.2  La solicitud de pago orquesta la validación"
  local tramite
  tramite=$(curl -s -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
    -d "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"verificacion\",\"monto\":15000,\"descripcion\":\"pago\"}" | jq -r '.id')

  check "pago de un trámite inexistente" "400" \
    "$(codigo -X POST "$BASE/api/v1/pagos" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d "{\"id_tramite\":\"T999\",\"usuario_id\":\"$USUARIO_ID\",\"monto\":1,\"metodo_pago\":\"x\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}")"
  check "pago con usuario inexistente" "400" \
    "$(codigo -X POST "$BASE/api/v1/pagos" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d "{\"id_tramite\":\"$tramite\",\"usuario_id\":\"99999999\",\"monto\":1,\"metodo_pago\":\"x\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}")"
  check "pago sin usuario_id" "400" \
    "$(codigo -X POST "$BASE/api/v1/pagos" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d "{\"id_tramite\":\"$tramite\",\"monto\":1,\"metodo_pago\":\"x\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}")"
  check "pago válido (queda pendiente)" "201" \
    "$(codigo -X POST "$BASE/api/v1/pagos" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d "{\"id_tramite\":\"$tramite\",\"usuario_id\":\"$usuario_id\",\"monto\":15000,\"metodo_pago\":\"tarjeta\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}")"

  sub "2.3  Tesorería o administración confirma el pago"
  local pago_id
  pago_id=$(sql pagos_db "SELECT id_pago FROM pagos WHERE id_tramite='$tramite' ORDER BY created_at DESC LIMIT 1")
  check_txt "el pago nace pendiente" "pendiente" \
    "$(sql pagos_db "SELECT estado FROM pagos WHERE id_pago='$pago_id'")"
  check "confirmar pago como admin" "200" \
    "$(codigo -X POST "$BASE/api/v1/pagos/$pago_id/confirmar" -H "X-Identidad: $IDENTIDAD")"

  sub "2.4  El estado del sistema"
  check_txt "el trámite quedó en estado pagado" "pagado" "$(sql municipalidad "SELECT estado FROM tramites WHERE id='$tramite'")"
  check_txt "el pago se guardó" "1" "$(sql pagos_db "SELECT count(*) FROM pagos WHERE id_tramite='$tramite'")"
  check_txt "la intención quedó confirmada" "confirmado" \
    "$(sql pagos_db "SELECT estado FROM pagos_intentos WHERE id_tramite='$tramite'")"

  sub "2.5  Coherencia entre las dos bases (sin pagos huérfanos)"
  local huerfanos
  huerfanos=$(sql municipalidad "SELECT id FROM tramites WHERE estado='pagado'" | sort \
    | comm -23 - <(sql pagos_db "SELECT DISTINCT id_tramite FROM pagos" | sort) | wc -l)
  check_txt "pagos huérfanos (pago sin trámite pagado)" "0" "$huerfanos"
  nota "   Comparación por lista: las tablas están en bases distintas, no hay JOIN posible."

  sub "2.6  Las validaciones son llamadas HTTP reales, no confianza"
  docker compose stop "${USUARIOS[@]}" >/dev/null 2>&1
  sleep 2
  check "crear trámite con usuarios caído" "503" \
    "$(codigo -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"verificacion\",\"monto\":1000,\"descripcion\":\"x\"}")"
  check_txt "no se creó el trámite pese a que el usuario existe" "0" \
    "$(sql municipalidad "SELECT count(*) FROM tramites WHERE descripcion='x'")"
  nota "   El usuario SÍ está en la base. Sin el servicio usuarios no se puede confirmar,"
  nota "   así que no se crea. Eso es validación real, no confianza en el cliente."
  docker compose up -d "${USUARIOS[@]}" >/dev/null 2>&1
  esperar_puerto 3335 60
  esperar_puerto 3336 60

  sub "2.7  Permisos por rol (ciudadano, tesorería, administración)"
  local ciudadano identidad_ciudadano ciudadano_id descripcion_ciudadano
  ciudadano=$(curl -s -X POST "$BASE/api/v1/usuarios" -H 'Content-Type: application/json' \
    -d "{\"dni\":\"$(nuevo_dni)\",\"email\":\"ciudadano$(date +%s)@mun.test\",\"password\":\"secreto123\",\"fullName\":\"Ciudadano\",\"passwordConfirmation\":\"secreto123\"}")
  identidad_ciudadano=$(printf '%s' "$ciudadano" | jq -r '.data.identidad // empty')
  ciudadano_id=$(printf '%s' "$ciudadano" | jq -r '.data.user.id // empty')
  descripcion_ciudadano="ciudadano_$(date +%s)"

  check "ciudadano no puede listar usuarios" "403" \
    "$(codigo -H "X-Identidad: $identidad_ciudadano" "$BASE/api/v1/usuarios")"
  check "ciudadano no puede confirmar pagos" "403" \
    "$(codigo -X POST "$BASE/api/v1/pagos/$pago_id/confirmar" -H "X-Identidad: $identidad_ciudadano")"
  check_txt "el ciudadano solo ve sus trámites" "0" \
    "$(curl -s -H "X-Identidad: $identidad_ciudadano" "$BASE/api/v1/tramites" | jq 'length')"
  check "ciudadano crea un trámite a su nombre" "201" \
    "$(codigo -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' -H "X-Identidad: $identidad_ciudadano" \
       -d "{\"tipo\":\"Otro\",\"tipoDetalle\":\"verificacion\",\"monto\":1000,\"descripcion\":\"$descripcion_ciudadano\"}")"
  check_txt "el trámite quedó a nombre del ciudadano" "$ciudadano_id" \
    "$(sql municipalidad "SELECT usuario_id FROM tramites WHERE descripcion='$descripcion_ciudadano' ORDER BY id DESC LIMIT 1")"
  check "ciudadano no puede pagar el trámite de otro" "403" \
    "$(codigo -X POST "$BASE/api/v1/pagos" -H 'Content-Type: application/json' -H "X-Identidad: $identidad_ciudadano" \
       -d "{\"id_tramite\":\"$tramite\",\"monto\":1,\"metodo_pago\":\"x\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}")"

  sub "2.8  Catálogo de estados del trámite (no cualquier texto)"
  local tramite_estado
  tramite_estado=$(curl -s -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
    -d "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"verificacion\",\"monto\":1000,\"descripcion\":\"estados\"}" | jq -r '.id')
  check "un estado inventado se rechaza" "400" \
    "$(codigo -X PATCH "$BASE/api/v1/tramites/$tramite_estado" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d '{"estado":"estado_inventado"}')"
  check "transición pendiente → en_revision" "200" \
    "$(codigo -X PATCH "$BASE/api/v1/tramites/$tramite_estado" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d '{"estado":"en_revision"}')"
  check "transición en_revision → pagado" "200" \
    "$(codigo -X PATCH "$BASE/api/v1/tramites/$tramite_estado" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d '{"estado":"pagado"}')"
  check "repetir el mismo estado es idempotente" "200" \
    "$(codigo -X PATCH "$BASE/api/v1/tramites/$tramite_estado" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d '{"estado":"pagado"}')"
  check "transición no permitida pagado → pendiente" "400" \
    "$(codigo -X PATCH "$BASE/api/v1/tramites/$tramite_estado" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d '{"estado":"pendiente"}')"
  check_txt "el estado no cambió tras el rechazo" "pagado" \
    "$(sql municipalidad "SELECT estado FROM tramites WHERE id='$tramite_estado'")"
  # El trámite de prueba no debe quedar en "pagado" sin pago: rompería el check 2.5
  # de la siguiente corrida. Se elimina al terminar.
  curl -s -o /dev/null -X DELETE "$BASE/api/v1/tramites/$tramite_estado" -H "X-Identidad: $IDENTIDAD"

  sub "2.9  Historial de estados (el sello de creación no se sobrescribe)"
  local tramite_historial sellos_antes lamport_actual
  tramite_historial=$(curl -s -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
    -d "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"verificacion\",\"monto\":1000,\"descripcion\":\"historial\"}" | jq -r '.id')
  check "el historial del trámite responde" "200" \
    "$(codigo -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites/$tramite_historial/eventos")"
  check_txt "el primer evento es la creación en 'pendiente'" "si" \
    "$(curl -s -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites/$tramite_historial/eventos" \
       | jq -r 'if length == 1 and .[0].estadoAnterior == null and .[0].estadoNuevo == "pendiente" then "si" else "no" end')"
  sellos_antes=$(sql municipalidad "SELECT lamport FROM tramites_eventos WHERE tramite_id='$tramite_historial' ORDER BY id ASC LIMIT 1")
  curl -s -o /dev/null -X PATCH "$BASE/api/v1/tramites/$tramite_historial" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
    -d '{"estado":"en_revision"}'
  check_txt "el cambio de estado se añade al historial" "si" \
    "$(curl -s -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites/$tramite_historial/eventos" \
       | jq -r 'if length == 2 and .[1].estadoAnterior == "pendiente" and .[1].estadoNuevo == "en_revision" then "si" else "no" end')"
  lamport_actual=$(sql municipalidad "SELECT lamport FROM tramites WHERE id='$tramite_historial'")
  check_txt "el sello de creación sigue intacto tras el PATCH" "si" \
    "$([ -n "$sellos_antes" ] && [ -n "$lamport_actual" ] && [ "$lamport_actual" -gt "$sellos_antes" ] \
       && [ "$(sql municipalidad "SELECT lamport FROM tramites_eventos WHERE tramite_id='$tramite_historial' ORDER BY id ASC LIMIT 1")" = "$sellos_antes" ] && echo si || echo no)"
  # Se elimina el trámite de prueba; sus eventos caen en cascada.
  curl -s -o /dev/null -X DELETE "$BASE/api/v1/tramites/$tramite_historial" -H "X-Identidad: $IDENTIDAD"
  check_txt "al eliminar el trámite se borra su historial" "0" \
    "$(sql municipalidad "SELECT count(*) FROM tramites_eventos WHERE tramite_id='$tramite_historial'")"

  sub "2.10 Concurrencia optimista (una escritura vieja no pisa la nueva)"
  local tramite_version version_inicial
  tramite_version=$(curl -s -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
    -d "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"concurrencia\",\"monto\":1000,\"descripcion\":\"version\"}" | jq -r '.id')
  version_inicial=$(sql municipalidad "SELECT version FROM tramites WHERE id='$tramite_version'")
  check_txt "el trámite nace en la versión 1" "1" "$version_inicial"
  check "el PATCH con la versión correcta se aplica" "200" \
    "$(codigo -X PATCH "$BASE/api/v1/tramites/$tramite_version" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d '{"estado":"en_revision","version":1}')"
  check "el PATCH con una versión vieja se rechaza" "409" \
    "$(codigo -X PATCH "$BASE/api/v1/tramites/$tramite_version" -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
       -d '{"estado":"pagado","version":1}')"
  check_txt "la escritura vieja no cambió el estado ni la versión" "en_revision:2" \
    "$(sql municipalidad "SELECT estado || ':' || version FROM tramites WHERE id='$tramite_version'")"
  curl -s -o /dev/null -X DELETE "$BASE/api/v1/tramites/$tramite_version" -H "X-Identidad: $IDENTIDAD"

  sub "2.11 Revocación de una identidad antes de que caduque"
  local dni_revocado alta_revocada identidad_revocada token_revocado jti_revocado
  dni_revocado=$(nuevo_dni)
  alta_revocada=$(curl -s -X POST "$BASE/api/v1/usuarios" -H 'Content-Type: application/json' \
    -d "{\"dni\":\"$dni_revocado\",\"email\":\"revoca$(date +%s)@mun.test\",\"password\":\"secreto123\",\"fullName\":\"Revocacion\",\"passwordConfirmation\":\"secreto123\"}")
  identidad_revocada=$(printf '%s' "$alta_revocada" | jq -r '.data.identidad // empty')
  token_revocado=$(printf '%s' "$alta_revocada" | jq -r '.data.token // empty')
  jti_revocado=$(printf '%s' "$alta_revocada" | jq -r '.data.identidadJti // empty')
  check "la identidad nueva sirve en trámites" "200" \
    "$(codigo -H "X-Identidad: $identidad_revocada" "$BASE/api/v1/tramites")"
  check "el logout revoca la identidad y el token" "200" \
    "$(codigo -X POST "$BASE/api/v1/account/logout" -H "Authorization: Bearer $token_revocado" \
       -H "X-Identidad: $identidad_revocada")"

  # Trámites cachea la lista de revocadas ~5 s: se espera a que se entere.
  local i estado_revocado=200
  for ((i = 0; i < 20; i += 2)); do
    estado_revocado=$(codigo -H "X-Identidad: $identidad_revocada" "$BASE/api/v1/tramites")
    [ "$estado_revocado" = "401" ] && break
    sleep 2
  done
  check "la identidad revocada deja de valer (401)" "401" "$estado_revocado"
  check "las demás identidades siguen valiendo" "200" \
    "$(codigo -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites")"

  # Limpieza: usuario de prueba y su revocación.
  sql usuarios_db "DELETE FROM users WHERE id='$dni_revocado'" >/dev/null
  [ -n "$jti_revocado" ] && sql usuarios_db "DELETE FROM identidades_revocadas WHERE jti='$jti_revocado'" >/dev/null

  sub "2.12 Reintento idempotente de la cola offline"
  local dni_offline alta_offline identidad_offline clave_offline t_offline t_normal
  local resp_offline code_offline cuerpo_offline resp_replay code_replay cuerpo_replay

  dni_offline=$(nuevo_dni)
  alta_offline=$(curl -s -X POST "$BASE/api/v1/usuarios" -H 'Content-Type: application/json' \
    -d "{\"dni\":\"$dni_offline\",\"email\":\"offline$(date +%s)@mun.test\",\"password\":\"secreto123\",\"fullName\":\"Cola Offline\",\"passwordConfirmation\":\"secreto123\"}")
  identidad_offline=$(printf '%s' "$alta_offline" | jq -r '.data.identidad // empty')
  clave_offline=$(cat /proc/sys/kernel/random/uuid)
  local cuerpo_offline_json
  cuerpo_offline_json='{"tipo":"Otro","tipoDetalle":"Reclamo en cola","descripcion":"prueba offline","monto":1500,"creadoClienteEn":"2026-10-20T10:00:00.000Z"}'

  resp_offline=$(curl -s --max-time 20 -w $'\n%{http_code}' -X POST "$BASE/api/v1/tramites" \
    -H 'Content-Type: application/json' -H "X-Identidad: $identidad_offline" \
    -H "Idempotency-Key: $clave_offline" -H 'X-Origen: offline' -d "$cuerpo_offline_json")
  code_offline="${resp_offline##*$'\n'}"
  cuerpo_offline="${resp_offline%$'\n'*}"
  t_offline=$(printf '%s' "$cuerpo_offline" | jq -r '.id // empty')

  check "el POST desde la cola offline se acepta" "201" "$code_offline"
  check_txt "el trámite queda marcado como offline" "offline" \
    "$(printf '%s' "$cuerpo_offline" | jq -r '.origen // "?"')"
  check_txt "conserva la fecha original, no la de sincronización" "2026-10-20" \
    "$(printf '%s' "$cuerpo_offline" | jq -r '.creadoClienteEn[0:10] // "?"')"

  resp_replay=$(curl -s --max-time 20 -w $'\n%{http_code}' -X POST "$BASE/api/v1/tramites" \
    -H 'Content-Type: application/json' -H "X-Identidad: $identidad_offline" \
    -H "Idempotency-Key: $clave_offline" -H 'X-Origen: offline' -d "$cuerpo_offline_json")
  code_replay="${resp_replay##*$'\n'}"
  cuerpo_replay="${resp_replay%$'\n'*}"
  check "el reintento con la misma clave responde 200" "200" "$code_replay"
  check_txt "devuelve el mismo trámite, sin duplicar" "$t_offline" \
    "$(printf '%s' "$cuerpo_replay" | jq -r '.id // "?"')"
  check_txt "la base tiene una sola fila para esa clave" "1" \
    "$(sql municipalidad "SELECT count(*) FROM tramites WHERE clave_idempotencia='$clave_offline'")"

  # Un trámite nuevo (fecha actual) no debe adelantar al que esperaba en cola.
  t_normal=$(curl -s --max-time 20 -X POST "$BASE/api/v1/tramites" \
    -H 'Content-Type: application/json' -H "X-Identidad: $identidad_offline" \
    -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" \
    -d '{"tipo":"Otro","tipoDetalle":"Reclamo nuevo","descripcion":"prueba orden","monto":2000,"creadoClienteEn":"2026-10-22T10:00:00.000Z"}' | jq -r '.id // empty')
  check_txt "ordena por la fecha real de solicitud" "$t_offline" \
    "$(curl -s --max-time 20 -H "X-Identidad: $identidad_offline" "$BASE/api/v1/tramites" | jq -r '.[0].id // "?"')"

  sql municipalidad "DELETE FROM tramites WHERE id IN ('$t_offline','$t_normal')" >/dev/null
  sql usuarios_db "DELETE FROM users WHERE id='$dni_offline'" >/dev/null
}

# ============================================================ PUNTO 3

punto3() {
  titulo "PUNTO 3 — Recuperación ante fallos"

  if [ -z "$IDENTIDAD" ]; then
    local sesion
    sesion=$(login admin@municipalidad.gob Municipal123)
    IDENTIDAD=$(printf '%s' "$sesion" | jq -r '.data.identidad // empty')
  fi

  sub "3.1  Respaldo de los datos"
  mkdir -p respaldos
  local marca="verif_$(date +%Y%m%d_%H%M%S)"
  local ok=1
  for db in municipalidad usuarios_db pagos_db; do
    docker compose exec -T postgres pg_dump -U municipalidad -Fc -d "$db" \
      >"respaldos/${db}_${marca}.dump" 2>/dev/null || ok=0
  done
  check_txt "pg_dump de las 3 bases de datos" "ok" "$([ "$ok" -eq 1 ] && echo ok || echo fallo)"
  local tam
  tam=$(du -k "respaldos/municipalidad_${marca}.dump" 2>/dev/null | cut -f1)
  check_txt "el respaldo no está vacío" "mayor-0" \
    "$([ -n "$tam" ] && [ "$tam" -gt 0 ] && echo mayor-0 || echo cero)"
  (cd respaldos && sha256sum "./municipalidad_${marca}.dump" > "sumas_${marca}.sha256" 2>/dev/null)
  check_txt "se puede calcular la suma de verificación" "ok" \
    "$([ -f "respaldos/sumas_${marca}.sha256" ] && echo ok || echo fallo)"

  sub "3.2  Registro de operaciones para poder retomarlas"
  check_txt "la tabla de intenciones existe" "1" \
    "$(sql pagos_db "SELECT count(*) FROM pg_tables WHERE tablename='pagos_intentos'")"
  check_txt "no queda ninguna intención pendiente" "0" \
    "$(sql pagos_db "SELECT count(*) FROM pagos_intentos WHERE estado='pendiente'")"
  check_txt "hay intenciones registradas" "ok" \
    "$([ "$(sql pagos_db 'SELECT count(*) FROM pagos_intentos')" -gt 0 ] && echo ok || echo ninguna)"

  sub "3.3  El reconciliador responde"
  local r
  r=$(curl -s --max-time 30 -X POST "$BASE/api/v1/intentos/reconciliar" 2>/dev/null)
  check_txt "POST /api/v1/intentos/reconciliar" "ok" \
    "$(echo "$r" | grep -q 'confirmados' && echo ok || echo fallo)"
  nota "   Devuelve: $r"

  sub "3.4  Archivado de WAL (lo que permite volver en el tiempo)"
  check_txt "archive_mode está activado" "on" "$(sql postgres 'SHOW archive_mode')"
  local wals
  wals=$(docker compose exec -T postgres sh -c 'ls -1 /archivos 2>/dev/null | wc -l' 2>/dev/null | tr -d '\r')
  check_txt "hay archivos de WAL archivados" "mayor-0" \
    "$([ -n "$wals" ] && [ "$wals" -gt 0 ] && echo mayor-0 || echo cero)"
  nota "   $wals archivos. Son los que permiten restaurar a un instante exacto, no solo al"
  nota "   último backup. Demostración completa: ./scripts/recuperacion.sh pitr-preparar"

  sub "3.5  La base de datos caída se detecta rápido (no 8 segundos)"
  docker compose stop postgres >/dev/null 2>&1
  sleep 2
  # Código y cuerpo salen de la MISMA petición: si se piden por separado, la
  # segunda ya recibe un 502 de nginx, porque nginx trata el 503 de la aplicación
  # como fallo del upstream y expulsa la réplica durante fail_timeout.
  local respuesta t0 t1 ms db_codigo cuerpo
  t0=$(date +%s%N)
  respuesta=$(curl -s --max-time 30 -w $'\n%{http_code}' \
    -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites")
  t1=$(date +%s%N)
  db_codigo="${respuesta##*$'\n'}"
  cuerpo="${respuesta%$'\n'*}"
  ms=$(( (t1 - t0) / 1000000 ))
  check "responde 503 con la base caída" "503" "$db_codigo"
  check_txt "el mensaje explica la causa" "si" \
    "$(echo "$cuerpo" | grep -qi 'base de datos' && echo si || echo "no: $(echo "$cuerpo" | head -c 90)")"
  check_txt "falla en menos de 3s (antes tardaba 8,4)" "menor-3000" \
    "$([ "$ms" -lt 3000 ] && echo menor-3000 || echo "lento:${ms}ms")"
  check "el gateway sigue vivo" "200" "$(codigo "$BASE/health")"
  docker compose start postgres >/dev/null 2>&1
  esperar_puerto_gw 90
  # Hay que esperar a que postgres acepte conexiones de verdad: si se comprueba
  # antes de tiempo, las réplicas aún devuelven 502 y el check falla por un motivo
  # que no tiene que ver con lo que se quiere medir.
  local i
  for ((i = 0; i < 60; i += 2)); do
    [ "$(codigo -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites")" = "200" ] && break
    sleep 2
  done
  check "vuelve a funcionar al levantar la base" "200" \
    "$(codigo -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/tramites")"
  # El pool de usuarios también tiene que recuperarse; tras reiniciar postgres
  # Docker puede tardar unos segundos en volver a resolver el nombre.
  for ((i = 0; i < 60; i += 2)); do
    [ "$(codigo -H "X-Identidad: $IDENTIDAD" "$BASE/api/v1/usuarios")" = "200" ] && break
    sleep 2
  done

  sub "3.6  Reinicio del servicio (lo que dispara la reconciliación)"
  docker compose restart pagos_1 >/dev/null 2>&1
  esperar_puerto 3337 90
  check "pagos vuelve a responder tras reiniciarse" "200" "$(codigo "http://localhost:3337/")"
  nota "   Al arrancar, cada réplica pasa el reconciliador: recupera lo que quedó a medias."
}

# ============================================================ PUNTO 4

punto4() {
  titulo "4. INTERFAZ WEB"
  sub "4.1  Se sirve desde el gateway"

  check "GET /ui/ sirve la interfaz" "200" "$(codigo "$BASE/ui/")"
  check "GET / redirige a /ui/" "302" "$(codigo "$BASE/")"

  sub "4.2  El administrador entra y su rol se respeta"

  local login token identidad identidad_perfil rol
  login=$(curl -s --max-time 20 -X POST "$BASE/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}')

  token=$(printf '%s' "$login" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
  check_txt "el login devuelve un token" "si" "$([ -n "$token" ] && echo si || echo no)"

  identidad=$(printf '%s' "$login" | grep -o '"identidad":"[^"]*"' | head -1 | cut -d'"' -f4)
  check_txt "el login devuelve la identidad firmada" "si" \
    "$([ -n "$identidad" ] && echo si || echo no)"

  local perfil
  perfil=$(curl -s --max-time 20 "$BASE/api/v1/account/profile" \
    -H "Authorization: Bearer $token")
  rol=$(printf '%s' "$perfil" | grep -o '"rol":"[^"]*"' | head -1 | cut -d'"' -f4)
  check_txt "el perfil confirma el rol admin" "admin" "$rol"

  identidad_perfil=$(printf '%s' "$perfil" | grep -o '"identidad":"[^"]*"' | head -1 | cut -d'"' -f4)
  check_txt "el perfil renueva la identidad" "si" \
    "$([ -n "$identidad_perfil" ] && echo si || echo no)"
}

# ============================================================ MAIN

printf '\n%sVERIFICACIÓN DEL PROYECTO%s\n' "$NEGRITA" "$FIN"
printf '%s%s%s\n' "$GRIS" "Comprueba los tres puntos del informe y deja constancia del resultado." "$FIN"

if [ "$(codigo "$BASE/health")" != "200" ]; then
  docker compose up -d >/dev/null 2>&1
  sleep 10
fi

punto1
punto2
punto3
punto4

# ------------------------------------------------------------------ resumen
titulo "RESUMEN"

TOTAL=$((TOTAL))
printf '   Comprobaciones: %s\n' "$TOTAL"
printf '   %sSuperadas:  %s%s\n' "$VERDE" "$PASADOS" "$FIN"
if [ "$FALLIDOS" -gt 0 ]; then
  printf '   %sFallidas:   %s%s\n' "$ROJO" "$FALLIDOS" "$FIN"
else
  printf '   %sFallidas:   0%s\n' "$VERDE" "$FIN"
fi

echo
if [ "$FALLIDOS" -eq 0 ]; then
  printf '   %s%s LOS TRES PUNTOS DEL INFORME QUEDAN VERIFICADOS.%s\n' "$VERDE" "$NEGRITA" "$FIN"
else
  printf '   %s%s HAY COMPROBACIONES QUE MIRAR.%s\n' "$ROJO" "$NEGRITA" "$FIN"
fi

echo
nota "Demostraciones largas, que modifican datos a propósito:"
nota "  ./scripts/demostracion.sh            # fallos y tiempos con p50/p95/máx"
nota "  ./scripts/recuperacion.sh saga       # una operación interrumpida se recupera sola"
nota "  ./scripts/recuperacion.sh pitr-*     # recuperar a un instante exacto"

exit 0