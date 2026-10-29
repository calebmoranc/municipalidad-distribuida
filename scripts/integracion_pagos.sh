#!/usr/bin/env bash
#
# Pruebas de integración del flujo de pago en dos pasos (H-17).
#
# A diferencia de las pruebas Japa (unitarias, sin Docker), aquí se ejercita el
# camino completo con los tres servicios reales a través del gateway:
#
#   ciudadano se registra → crea su trámite → solicita el pago (queda pendiente)
#   → no puede confirmarlo → tesorería lo confirma → trámite 'pagado'
#   → reconfirmar es idempotente (no duplica pago ni intención)
#
# Crea sus propios datos (usuario, trámite y pago con marcas únicas) y los borra
# al terminar. No toca contenedores ni los datos existentes.
#
#   ./scripts/integracion_pagos.sh
#
# La ventana de la saga (proceso que muere entre la intención y el PATCH) se
# demuestra aparte, porque apaga una réplica:
#   ./scripts/recuperacion.sh saga

set -uo pipefail

cd "$(dirname "$0")/.."

BASE="http://localhost:8080"

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
    FALLIDOS=$((FALLIDOS + 1))
    printf '   %sFAIL%s  %-52s esperado "%s", obtenido "%s"\n' "$ROJO" "$FIN" "$desc" "$esperado" "$valor"
  fi
}

codigo() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

login() {
  curl -s --max-time 20 -X POST "$BASE/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}"
}

# sql <base> <consulta>
sql() {
  docker compose exec -T postgres psql -U municipalidad -d "$1" -tAc "$2" 2>/dev/null | tr -d '\r'
}

nuevo_dni() {
  printf '9%07d' "$(( (RANDOM * 32768 + RANDOM) % 10000000 ))"
}

marca="integ_$(date +%Y%m%d_%H%M%S)"

if [ "$(codigo "$BASE/health")" != "200" ]; then
  printf '%sEl gateway no responde en %s. Levanta el stack: docker compose up -d%s\n' "$ROJO" "$BASE" "$FIN"
  exit 1
fi

titulo "INTEGRACIÓN — Flujo de pago en dos pasos"

# Datos a limpiar al final.
DNI=""
IDENTIDAD_ADMIN=""
TRAMITE=""
TRAMITE_AJENO=""
PAGO=""

limpiar() {
  [ -n "$TRAMITE" ] && curl -s -o /dev/null -X DELETE "$BASE/api/v1/tramites/$TRAMITE" \
    -H "X-Identidad: $IDENTIDAD_ADMIN" 2>/dev/null
  [ -n "$TRAMITE_AJENO" ] && curl -s -o /dev/null -X DELETE "$BASE/api/v1/tramites/$TRAMITE_AJENO" \
    -H "X-Identidad: $IDENTIDAD_ADMIN" 2>/dev/null
  [ -n "$PAGO" ] && sql pagos_db "DELETE FROM pagos_intentos WHERE pago_id='$PAGO'" >/dev/null 2>&1
  [ -n "$PAGO" ] && sql pagos_db "DELETE FROM pagos WHERE id_pago='$PAGO'" >/dev/null 2>&1
  [ -n "$DNI" ] && sql usuarios_db "DELETE FROM users WHERE id='$DNI'" >/dev/null 2>&1
}
trap limpiar EXIT INT TERM

# ---------------------------------------------------------------- Preparación

sub "1. Preparación: un ciudadano real se registra y crea su trámite"
DNI=$(nuevo_dni)
CORREO="integ${marca}@mun.test"
CLAVE="secreto123"

registro=$(curl -s --max-time 20 -X POST "$BASE/api/v1/usuarios" \
  -H 'Content-Type: application/json' \
  -d "{\"dni\":\"$DNI\",\"email\":\"$CORREO\",\"password\":\"$CLAVE\",\"fullName\":\"Integracion\",\"passwordConfirmation\":\"$CLAVE\"}")
check_txt "el ciudadano se registra" "$DNI" "$(printf '%s' "$registro" | jq -r '.data.user.id // empty')"

sesion_ciudadano=$(login "$CORREO" "$CLAVE")
IDENTIDAD_CIUDADANO=$(printf '%s' "$sesion_ciudadano" | jq -r '.data.identidad // empty')
check_txt "el ciudadano inicia sesión" "si" \
  "$([ -n "$IDENTIDAD_CIUDADANO" ] && echo si || echo no)"

TRAMITE=$(curl -s --max-time 20 -X POST "$BASE/api/v1/tramites" \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD_CIUDADANO" \
  -d "{\"usuarioId\":\"$DNI\",\"tipo\":\"Otro\",\"tipoDetalle\":\"$marca\",\"monto\":15000,\"descripcion\":\"integracion\"}" \
  | jq -r '.id // empty')
check_txt "el ciudadano crea su propio trámite" "si" \
  "$([ -n "$TRAMITE" ] && echo si || echo no)"

sesion_admin=$(login admin@municipalidad.gob Municipal123)
IDENTIDAD_ADMIN=$(printf '%s' "$sesion_admin" | jq -r '.data.identidad // empty')
ADMIN_ID=$(printf '%s' "$sesion_admin" | jq -r '.data.user.id // empty')
TRAMITE_AJENO=$(curl -s --max-time 20 -X POST "$BASE/api/v1/tramites" \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD_ADMIN" \
  -d "{\"usuarioId\":\"$ADMIN_ID\",\"tipo\":\"Otro\",\"tipoDetalle\":\"$marca-ajeno\",\"monto\":1000,\"descripcion\":\"ajeno\"}" \
  | jq -r '.id // empty')

# --------------------------------------------------------- Solicitud de pago

sub "2. El ciudadano SOLICITA el pago (todavía no se acredita)"
solicitud=$(curl -s --max-time 20 -X POST "$BASE/api/v1/pagos" \
  -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD_CIUDADANO" \
  -d "{\"id_tramite\":\"$TRAMITE\",\"monto\":15000,\"metodo_pago\":\"tarjeta\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}")
PAGO=$(printf '%s' "$solicitud" | jq -r '.idPago // empty')
check_txt "la solicitud devuelve un pago" "si" "$([ -n "$PAGO" ] && echo si || echo no)"
check_txt "el pago nace pendiente" "pendiente" "$(printf '%s' "$solicitud" | jq -r '.estado // empty')"
check_txt "el usuario del pago es la identidad, no el cuerpo" "$DNI" "$(printf '%s' "$solicitud" | jq -r '.usuarioId // empty')"
check_txt "el trámite NO se marca pagado en la solicitud" "pendiente" \
  "$(sql municipalidad "SELECT estado FROM tramites WHERE id='$TRAMITE'")"
check_txt "no se crea intención de saga al solicitar" "0" \
  "$(sql pagos_db "SELECT count(*) FROM pagos_intentos WHERE id_tramite='$TRAMITE'")"

sub "3. Permisos: el ciudadano no puede acreditarse el pago"
check "el ciudadano no puede confirmar su pago" "403" \
  "$(codigo -X POST "$BASE/api/v1/pagos/$PAGO/confirmar" -H "X-Identidad: $IDENTIDAD_CIUDADANO")"
check "el ciudadano no puede pagar un trámite ajeno" "403" \
  "$(codigo -X POST "$BASE/api/v1/pagos" -H 'Content-Type: application/json' \
     -H "X-Identidad: $IDENTIDAD_CIUDADANO" \
     -d "{\"id_tramite\":\"$TRAMITE_AJENO\",\"monto\":1000,\"metodo_pago\":\"x\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}")"

# ------------------------------------------------------------- Confirmación

sub "4. Tesorería CONFIRMA el pago: es el segundo paso"
sesion_tesoreria=$(login tesoreria@municipalidad.gob Tesoreria123)
IDENTIDAD_TESORERIA=$(printf '%s' "$sesion_tesoreria" | jq -r '.data.identidad // empty')
check "tesorería confirma el pago" "200" \
  "$(codigo -X POST "$BASE/api/v1/pagos/$PAGO/confirmar" -H "X-Identidad: $IDENTIDAD_TESORERIA")"
check_txt "el pago queda pagado" "pagado" "$(sql pagos_db "SELECT estado FROM pagos WHERE id_pago='$PAGO'")"
check_txt "el trámite queda pagado" "pagado" \
  "$(sql municipalidad "SELECT estado FROM tramites WHERE id='$TRAMITE'")"
check_txt "la intención de la saga queda confirmada" "confirmado" \
  "$(sql pagos_db "SELECT estado FROM pagos_intentos WHERE pago_id='$PAGO'")"

# ------------------------------------------------------------- Idempotencia

sub "5. Reconfirmar es idempotente (no duplica ni toca el trámite otra vez)"
version_antes=$(sql municipalidad "SELECT version FROM tramites WHERE id='$TRAMITE'")
check "reconfirmar responde 200" "200" \
  "$(codigo -X POST "$BASE/api/v1/pagos/$PAGO/confirmar" -H "X-Identidad: $IDENTIDAD_TESORERIA")"
check_txt "sigue habiendo un solo pago" "1" \
  "$(sql pagos_db "SELECT count(*) FROM pagos WHERE id_pago='$PAGO'")"
check_txt "sigue habiendo una sola intención" "1" \
  "$(sql pagos_db "SELECT count(*) FROM pagos_intentos WHERE pago_id='$PAGO'")"
check_txt "la versión del trámite no cambia al reconfirmar" "$version_antes" \
  "$(sql municipalidad "SELECT version FROM tramites WHERE id='$TRAMITE'")"

# ------------------------------------------------------------------ Resumen

titulo "RESUMEN"
printf '   Comprobaciones: %s\n' "$TOTAL"
printf '   %sSuperadas:  %s%s\n' "$VERDE" "$PASADOS" "$FIN"
printf '   %sFallidas:   %s%s\n' "$([ "$FALLIDOS" -eq 0 ] && printf '%s' "$VERDE" || printf '%s' "$ROJO")" "$FALLIDOS" "$FIN"
printf '\n'
if [ "$FALLIDOS" -eq 0 ]; then
  printf '    %sFLUJO DE PAGO EN DOS PASOS VERIFICADO.%s\n' "$VERDE" "$FIN"
  exit 0
fi
printf '    %sHAY %s COMPROBACIONES FALLIDAS.%s\n' "$ROJO" "$FALLIDOS" "$FIN"
exit 1
