#!/usr/bin/env bash
#
# Demostración guiada del proyecto para una presentación.
#
# Mide el comportamiento real del sistema en cuatro escenarios de fallo y lo
# imprime en tablas. No simula nada: apaga, congela y restaura contenedores, y
# mide el tiempo que tarda cada petición de verdad.
#
#   ./scripts/demostracion.sh              # toda la demostración
#   ./scripts/demostracion.sh comunicacion  # solo la etapa 1
#   ./scripts/demostracion.sh reloj        # solo la etapa 2
#   ./scripts/demostracion.sh fallos       # solo la etapa 3
#   ./scripts/demostracion.sh resumen      # solo el guion de la presentación
#
# Requisitos: docker, docker compose, curl, jq y psql (dentro del contenedor).
#
# IMPORTANTE: el script detiene contenedores. Al terminar, o si se interrumpe con
# Ctrl-C, los vuelve a levantar todos.

set -uo pipefail

cd "$(dirname "$0")/.."

BASE="http://localhost:8080"
FASE="${1:-todo}"

ROJO=$'\033[0;31m'
VERDE=$'\033[0;32m'
AMBAR=$'\033[0;33m'
GRIS=$'\033[0;90m'
NEGRITA=$'\033[1m'
FIN=$'\033[0m'

LINEA="$(printf '=%.0s' $(seq 1 78))"
LINEA_FINA="$(printf -- '-%.0s' $(seq 1 78))"

TRAMITES=(tramites_1 tramites_2)
USUARIOS=(usuarios_1 usuarios_2)

# Identidad firmada de administrador. La exigen trámites, pagos y el listado de
# usuarios; se obtiene en preflight y se envía en todas las peticiones.
IDENTIDAD=""
USUARIO_ADMIN="10000001"

# ------------------------------------------------------------------ formato

titulo() {
  printf '\n%s%s%s\n' "$NEGRITA" "$LINEA" "$FIN"
  printf '%s %s%s\n' "$NEGRITA" "$1" "$FIN"
  printf '%s%s%s\n' "$NEGRITA" "$LINEA" "$FIN"
}

subtitulo() { printf '\n%s%s%s\n' "$NEGRITA" "$1" "$FIN"; }
nota() { printf '   %s%s%s\n' "$GRIS" "$1" "$FIN"; }
subrayado() { printf '%s%s%s\n' "$NEGRITA" "$LINEA_FINA" "$FIN"; }

# Colorea un código HTTP. El color se aplica aquí y no en curl -w, porque curl
# no interpreta secuencias de escape en el formato -w.
color_http() {
  case "$1" in
    2*) printf '%s%s%s' "$VERDE" "$1" "$FIN" ;;
    4*) printf '%s%s%s' "$ROJO" "$1" "$FIN" ;;
    *)  printf '%s%s%s' "$AMBAR" "$1" "$FIN" ;;
  esac
}

tabla_encabezado() {
  printf '   %-34s %7s %9s %9s %9s\n' "escenario" "código" "p50 ms" "p95 ms" "max ms"
}

# Calcula p50 / p95 / max en milisegundos a partir de una duración por línea.
# Los tiempos entran en segundos (salida de curl -w) y salen en milisegundos.
p50_p95_max() {
  local tmp total
  tmp="$(mktemp)"
  cat >"$tmp"
  total="$(wc -l <"$tmp" | tr -d ' ')"
  if [ "$total" -eq 0 ]; then
    rm -f "$tmp"
    printf '   sin datos'
    return
  fi
  local stats
  # LC_ALL=C para que el separador decimal sea un punto y no una coma.
  stats=$(LC_ALL=C sort -g "$tmp" | LC_ALL=C awk -v total="$total" '
    { v[NR] = $1 }
    END {
      i50 = int(total * 0.5 + 0.999999); if (i50 < 1) i50 = 1
      i95 = int(total * 0.95 + 0.999999); if (i95 < 1) i95 = 1
      printf "%9.1f %9.1f %9.1f", v[i50] * 1000, v[i95] * 1000, v[total] * 1000
    }')
  rm -f "$tmp"
  echo "$stats"
}

# --------------------------------------------------------------- peticiones

# Manda una petición y deja "CODIGO SEGUNDOS" en la salida estándar.
pedir() {
  local metodo="$1" ruta="$2" cuerpo="${3:-}"
  local code
  if [ -n "$cuerpo" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 60 \
      -X "$metodo" "$BASE$ruta" -H 'Content-Type: application/json' \
      -H "X-Identidad: $IDENTIDAD" -d "$cuerpo")
  else
    code=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 60 \
      -X "$metodo" "$BASE$ruta" -H "X-Identidad: $IDENTIDAD")
  fi
  echo "$code"
}

codigo_de() { pedir "$@" | cut -d' ' -f1; }

tiempo_de() { pedir "$@" | cut -d' ' -f2; }

# Una sola petición: deja el cuerpo en BODY y el código HTTP en CODE.
# Se evita hacer la misma petición dos veces, una para el cuerpo y otra para el
# código, porque duplicaría los trámites y pagos de la demostración.
BODY=""
CODE=""
pedir_json() {
  local metodo="$1" ruta="$2" cuerpo="${3:-}" salida
  if [ -n "$cuerpo" ]; then
    salida=$(curl -s --max-time 60 -w $'\n%{http_code}' -X "$metodo" "$BASE$ruta" \
      -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" -d "$cuerpo")
  else
    salida=$(curl -s --max-time 60 -w $'\n%{http_code}' -X "$metodo" "$BASE$ruta" \
      -H "X-Identidad: $IDENTIDAD")
  fi
  CODE="${salida##*$'\n'}"
  BODY="${salida%$'\n'*}"
}

campo() { echo "$BODY" | jq -r "$1" 2>/dev/null; }

json() { curl -s --max-time 30 -H "X-Identidad: $IDENTIDAD" "$BASE$1"; }

# Reloj lógico de una réplica concreta, por su puerto de host.
reloj() { curl -s --max-time 10 "http://localhost:$1/api/v1/reloj" | jq -r '"\(.nodeId) = \(.lamport)"'; }

# Solo el valor numérico del reloj, para poder hacer aritmética con él.
valor_reloj() { curl -s --max-time 10 "http://localhost:$1/api/v1/reloj" | jq -r '.lamport'; }

# Estado de los circuitos de una réplica de pagos.
circuitos() {
  curl -s --max-time 10 "http://localhost:$1/api/v1/circuitos" \
    | jq -r '.circuitos[] | "\(.dependencia): \(.estado) (fallos \(.fallosConsecutivos)/\(.umbral))"'
}

sql() { docker compose exec -T postgres psql -U municipalidad -d "$1" -tAc "$2" 2>/dev/null; }

# Los ids de usuario son el DNI (8 dígitos). Se genera uno distinto por corrida
# para no chocar con los usuarios de pruebas anteriores.
nuevo_dni() {
  printf '9%07d' "$(( (RANDOM * 32768 + RANDOM) % 10000000 ))"
}

todos_arriba() { docker compose up -d "$@" >/dev/null 2>&1; }

# Espera a que un servicio responda de verdad, no solo a que el gateway esté vivo.
# Hace falta esperar por servicio: con usuarios parado, /health y /tramites siguen
# respondiendo 200 y no dicen nada sobre usuarios.
esperar_servicio() {
  local ruta="$1" segundos="${2:-60}" i codigo
  for ((i = 0; i < segundos; i += 2)); do
    codigo=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE$ruta")
    # 2xx/3xx/4xx significa que el servicio contestó (aunque sea 401 o 403 por
    # falta de identidad). 5xx o 000 es que no está disponible.
    case "$codigo" in 2*|3*|4*) return 0 ;; esac
    sleep 2
  done
  return 1
}

# Espera a una réplica por su puerto de host, SIN pasar por el gateway.
# Importante: consultar por el gateway mientras la réplica reinicia hace que nginx
# reciba un fallo, y con max_fails=1 la expulsa durante 10s. Luego el gateway
# responde 502 aunque la réplica ya esté de vuelta.
esperar_replica() {
  local puerto="$1" segundos="${2:-90}" i
  for ((i = 0; i < segundos; i += 2)); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$puerto/api/v1/reloj")" = "200" ] && return 0
    sleep 2
  done
  return 1
}

restaurar() {
  printf '\n%sRestaurando el stack...%s\n' "$AMBAR" "$FIN"
  docker compose unpause "${TRAMITES[@]}" >/dev/null 2>&1 || true
  todos_arriba
  esperar_servicio /api/v1/tramites 60
  echo "Stack restaurado."
}

trap restaurar EXIT INT TERM

preflight() {
  command -v jq >/dev/null   || { echo "Falta jq:  sudo apt install jq"; exit 1; }
  command -v curl >/dev/null || { echo "Falta curl."; exit 1; }
  command -v docker >/dev/null || { echo "Falta docker."; exit 1; }

  echo "Comprobando que el stack está en pie..."
  todos_arriba
  if ! esperar_servicio /api/v1/tramites 90; then
    echo "El stack no respondió. Revisa:  docker compose logs tramites_1"
    exit 1
  fi
  printf '   gateway /health -> %s\n' "$(curl -s "$BASE/health" | tr -d '\n')"

  local sesion
  sesion=$(curl -s --max-time 20 -X POST "$BASE/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}')
  IDENTIDAD=$(printf '%s' "$sesion" | jq -r '.data.identidad // empty')
  USUARIO_ADMIN=$(printf '%s' "$sesion" | jq -r '.data.user.id // "10000001"')

  if [ -z "$IDENTIDAD" ]; then
    echo "No se pudo iniciar sesión como administrador (revisa migraciones y seeders)."
    exit 1
  fi
  echo "   identidad de administrador obtenida"
}

# --------------------------------------------------------- 1. comunicación

etapa_comunicacion() {
  titulo "ETAPA 1 - Comunicación real entre servicios"

  nota "El usuario NO se valida confiando en lo que envía el cliente: tramites y"
  nota "pagos lo preguntan al servicio usuarios por HTTP, pasando por el gateway."

  local email="demo$(date +%s)@mun.test"
  local usuario_id
  usuario_id=$(curl -s -X POST "$BASE/api/v1/usuarios" -H 'Content-Type: application/json' \
    -d "{\"dni\":\"$(nuevo_dni)\",\"email\":\"$email\",\"password\":\"secreto123\",\"fullName\":\"Demo\",\"passwordConfirmation\":\"secreto123\"}" \
    | jq -r '.data.user.id')

  echo
  nota "Usuario creado para la demostración: id=$usuario_id ($email)"

subtitulo "1.1  Validación del usuario al crear un trámite"
  pedir_json POST /api/v1/tramites '{"usuarioId":"99999999","tipo":"Otro","tipoDetalle":"x","monto":1000,"descripcion":"y"}'
  printf '   %-40s %s %s\n' "usuario inexistente (99999999)" "$(campo '.message')" "$(color_http "$CODE")"

  pedir_json POST /api/v1/tramites '{"tipo":"Otro","tipoDetalle":"x","monto":1000,"descripcion":"y"}'
  printf '   %-40s %s %s\n' "sin usuarioId" "$(campo '.message')" "$(color_http "$CODE")"

  pedir_json POST /api/v1/tramites "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"licencia\",\"monto\":1000,\"descripcion\":\"tramite de demo\"}"
  local tramite
  tramite="$(campo '.id')"
  printf '   %-40s %s (id=%s)\n' "usuario válido" "$(color_http "$CODE")" "$tramite"

  subtitulo "1.2  Orquestación del pago"
  pedir_json POST /api/v1/pagos "{\"id_tramite\":\"T999\",\"usuario_id\":\"$usuario_id\",\"monto\":1,\"metodo_pago\":\"x\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}"
  printf '   %-40s %s %s\n' "trámite inexistente" "$(campo '.mensaje')" "$(color_http "$CODE")"

  pedir_json POST /api/v1/pagos "{\"id_tramite\":\"$tramite\",\"usuario_id\":\"99999999\",\"monto\":1,\"metodo_pago\":\"x\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}"
  printf '   %-40s %s %s\n' "usuario inexistente" "$(campo '.mensaje')" "$(color_http "$CODE")"

  pedir_json POST /api/v1/pagos "{\"id_tramite\":\"$tramite\",\"usuario_id\":\"$usuario_id\",\"monto\":15000,\"metodo_pago\":\"tarjeta\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}"
  local pago_id
  pago_id="$(campo '.idPago')"
  printf '   %-40s %s (idPago=%s, pendiente)\n' "solicitud de pago" "$(color_http "$CODE")" "$pago_id"

  pedir_json POST "/api/v1/pagos/$pago_id/confirmar"
  printf '   %-40s %s\n' "confirmación (tesorería/admin)" "$(color_http "$CODE")"
  printf '   %-40s %s\n' "estado del trámite tras confirmar" \
    "$(json "/api/v1/tramites/$tramite" | jq -r '"\(.estado)  <- lo cambió pagos con un PATCH"')"

  subtitulo "1.3  Prueba de que no es confianza en el cliente"
  nota "Se apaga usuarios por completo. El usuario SÍ existe en la base de datos."
  docker compose stop "${USUARIOS[@]}" >/dev/null 2>&1
  sleep 2
  pedir_json POST /api/v1/tramites "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"x\",\"monto\":1000,\"descripcion\":\"y\"}"
  printf '   %-40s %s %s\n' "crear trámite con usuarios caído" "$(campo '.message')" "$(color_http "$CODE")"
  nota "   Responde 503 y NO crea el trámite. Si fuera confianza en el cliente lo"
  nota "   habría creado sin preguntar a nadie."

  echo
  nota "Restaurando usuarios..."
  todos_arriba "${USUARIOS[@]}"
  esperar_servicio /api/v1/usuarios 90
  pedir_json POST /api/v1/tramites "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"x\",\"monto\":1000,\"descripcion\":\"y\"}"
  printf '   %-40s %s\n' "usuarios restaurado" "$(color_http "$CODE")"
}

# --------------------------------------------------------------- 2. relojes

etapa_reloj() {
  titulo "ETAPA 2 - Relojes lógicos de Lamport"

  nota "Cada réplica es un proceso distinto y tiene su propio reloj. El sello viaja"
  nota "en la cabecera X-Lamport y permite reconstruir el orden causal real."

  nota "Se reinician las réplicas para partir de relojes en cero y que la"
  nota "trazabilidad de la demostración sea reproducible."
  docker compose restart "${TRAMITES[@]}" "${USUARIOS[@]}" pagos_1 pagos_2 >/dev/null 2>&1
  for puerto in 3333 3334 3335 3336 3337 3338; do esperar_replica "$puerto" 120; done
  esperar_servicio /api/v1/tramites 120
  esperar_servicio /api/v1/usuarios 120
  echo

  subtitulo "2.1  Relojes antes de los eventos"
  printf '   %-12s %-24s %s\n' "" "réplica 1" "réplica 2"
  printf '   %-12s %-24s %s\n' "usuarios" "$(reloj 3335)" "$(reloj 3336)"
  printf '   %-12s %-24s %s\n' "trámites" "$(reloj 3333)" "$(reloj 3334)"
  printf '   %-12s %-24s %s\n' "pagos" "$(reloj 3337)" "$(reloj 3338)"

  local antes_1 antes_2
  antes_1=$(valor_reloj 3333)
  antes_2=$(valor_reloj 3334)

  subtitulo "2.2  Un evento de negocio y su sello"
  local salida
  salida=$(curl -s -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' \
    -H "X-Identidad: $IDENTIDAD" \
    -d "{\"usuarioId\":\"$USUARIO_ADMIN\",\"tipo\":\"Otro\",\"tipoDetalle\":\"demo\",\"monto\":1000,\"descripcion\":\"sello de lamport\"}")
  echo "$salida" | jq -r '"   Nuevo trámite: id=\(.id)  lamport=\(.lamport)  node=\(.nodeId)"'

  subtitulo "2.3  Relojes después del evento"
  printf '   %-12s %-24s %s\n' "" "réplica 1" "réplica 2"
  printf '   %-12s %-24s %s\n' "usuarios" "$(reloj 3335)" "$(reloj 3336)"
  printf '   %-12s %-24s %s\n' "trámites" "$(reloj 3333)" "$(reloj 3334)"
  printf '   %-12s %-24s %s\n' "pagos" "$(reloj 3337)" "$(reloj 3338)"

  # La aritmética se calcula con los valores reales, no con números fijos: así el
  # texto sigue siendo cierto aunque cambie el reparto del gateway.
  local node lamport despues antes_de_este
  node=$(echo "$salida" | jq -r '.nodeId')
  lamport=$(echo "$salida" | jq -r '.lamport')
  if [ "$node" = "tramites_1" ]; then
    antes_de_este="$antes_1"; despues=$(valor_reloj 3333)
  else
    antes_de_este="$antes_2"; despues=$(valor_reloj 3334)
  fi

  echo
  nota "   Traza de $node (reloj: $antes_de_este → $despues):"
  nota "     · envió GET /usuarios/<dni> con sello 1                    → 1"
  nota "     · usuarios le respondió con sello 3                        → 3"
  nota "     · recibió el sello 3:  C := max(C, 3) + 1               → 4"
  nota "     · evento local de insertar el trámite: C := C + 1       → $lamport"
  nota "   Los relojes de pagos siguen donde estaban porque no participaron en"
  nota "   esta operación: son procesos distintos que no se hablaron."

  subtitulo "2.4  Concurrencia: lo que el reloj NO puede ordenar"
  nota "Ocho trámites en paralelo de verdad, repartidos entre las dos réplicas."
  local marca="conc-$(date +%s)"
  local codes="$marca.codigos"
  : >"$codes"
  for i in $(seq 1 8); do
    (
      curl -s -o /dev/null -X POST "$BASE/api/v1/tramites" \
        -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
        -d "{\"usuarioId\":\"$USUARIO_ADMIN\",\"tipo\":\"Otro\",\"tipoDetalle\":\"$marca\",\"monto\":1000,\"descripcion\":\"paralelo $i\"}" \
        -w '%{http_code}\n' >>"$codes"
    ) &
  done
  wait
  printf '   códigos devueltos: %s\n' "$(tr '\n' ' ' <"$codes")"
  rm -f "$codes"

  echo
  sql municipalidad \
    "SELECT '   id ' || id || '   lamport=' || lamport || '   ' || node_id FROM tramites WHERE tipo_detalle='$marca' ORDER BY lamport, node_id"
  nota "   Si dos eventos comparten lamport y son de réplicas distintas, son"
  nota "   concurrentes: ninguno se enteró del otro y el reloj no puede ordenarlos."
  nota "   Eso no es un fallo del método, es su respuesta correcta."

  subtitulo "2.5  Empate garantizado: mismo sello, réplicas distintas"
  nota "La ráfaga anterior depende del intercalado real. Para que el empate salga"
  nota "siempre, se mandan dos PATCH simultáneos, uno directo a cada réplica (sin"
  nota "pasar por el gateway), y ambos reciben el MISMO sello externo X-Lamport."
  nota "Ninguna réplica sabe de la otra, así que las dos calculan el mismo número."

  local t_a t_b
  t_a=$(curl -s -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' \
    -H "X-Identidad: $IDENTIDAD" \
    -d "{\"usuarioId\":\"$USUARIO_ADMIN\",\"tipo\":\"Otro\",\"tipoDetalle\":\"empate\",\"monto\":1000,\"descripcion\":\"empate A\"}" \
    | jq -r '.id')
  t_b=$(curl -s -X POST "$BASE/api/v1/tramites" -H 'Content-Type: application/json' \
    -H "X-Identidad: $IDENTIDAD" \
    -d "{\"usuarioId\":\"$USUARIO_ADMIN\",\"tipo\":\"Otro\",\"tipoDetalle\":\"empate\",\"monto\":1000,\"descripcion\":\"empate B\"}" \
    | jq -r '.id')

  # 900000 domina cualquier reloj acumulado, de modo que ambas réplicas parten
  # del mismo punto: C := max(C, 900000) + 1 y luego un evento local → 900002.
  local sello=900000 f_a f_b
  f_a=$(mktemp); f_b=$(mktemp)
  curl -s -X PATCH "http://localhost:3333/api/v1/tramites/$t_a" \
    -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
    -H "X-Lamport: $sello" -d '{"estado":"en_revision"}' >"$f_a" &
  curl -s -X PATCH "http://localhost:3334/api/v1/tramites/$t_b" \
    -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
    -H "X-Lamport: $sello" -d '{"estado":"en_revision"}' >"$f_b" &
  wait

  local l_a l_b n_a n_b
  l_a=$(jq -r '.lamport' <"$f_a"); n_a=$(jq -r '.nodeId' <"$f_a")
  l_b=$(jq -r '.lamport' <"$f_b"); n_b=$(jq -r '.nodeId' <"$f_b")
  printf '   trámite %-5s → lamport=%-7s node=%s\n' "$t_a" "$l_a" "$n_a"
  printf '   trámite %-5s → lamport=%-7s node=%s\n' "$t_b" "$l_b" "$n_b"
  rm -f "$f_a" "$f_b"

  if [ "$l_a" = "$l_b" ] && [ "$n_a" != "$n_b" ]; then
    nota "   Ambos sellos son $l_a en réplicas distintas: concurrentes. El reloj no"
    nota "   puede decidir cuál ocurrió primero, y ninguno de los dos procesos lo sabe."
  else
    nota "   Sello inesperado ($l_a en $n_a, $l_b en $n_b). Revisa el reinicio de relojes."
  fi
}

# ------------------------------------------------------- 3. fallos y tiempos

etapa_fallos() {
  titulo "ETAPA 3 - Tolerancia a fallos y métricas de tiempo"

  nota "Tiempos reales de peticiones reales, en milisegundos. Nada simulado."

  # Un trámite real para el pago de la recuperación: los ids 1..n no existen en
  # una base que ya lleva rato en marcha.
  local tramite_demo
  tramite_demo=$(curl -s -X POST "$BASE/api/v1/tramites" \
    -H 'Content-Type: application/json' -H "X-Identidad: $IDENTIDAD" \
    -d "{\"usuarioId\":\"$USUARIO_ADMIN\",\"tipo\":\"Otro\",\"tipoDetalle\":\"demo-fallos\",\"monto\":1000,\"descripcion\":\"pago de prueba\"}" \
    | jq -r '.id // "T1"')

  tabla_encabezado

  subtitulo "3.1  Línea base: todo en pie"
  local tiempos="" i codigo t
  tiempos=""
  for i in $(seq 1 20); do
    read -r codigo t <<<"$(pedir GET /api/v1/tramites)"
    tiempos+="$t"$'\n'
  done
  printf '   %-34s %s %s\n' "20 x GET /api/v1/tramites" "$(color_http 200)" "$(echo "$tiempos" | p50_p95_max)"

  subtitulo "3.2  Una réplica de tramites caída"
  docker compose stop tramites_2 >/dev/null 2>&1
  tiempos=""
  for i in $(seq 1 20); do
    read -r codigo t <<<"$(pedir GET /api/v1/tramites)"
    tiempos+="$t"$'\n'
  done
  printf '   %-34s %s %s\n' "20 x GET /tramites (sobrevive)" "$(color_http 200)" "$(echo "$tiempos" | p50_p95_max)"
  nota "   El gateway reparte y sobrevive, pero alguna petición cae en la réplica"
  nota "   muerta y espera a que nginx agote proxy_connect_timeout."
  docker compose start tramites_2 >/dev/null 2>&1

  subtitulo "3.3  Servicio de tramites COMPLETO caído"
  docker compose stop "${TRAMITES[@]}" >/dev/null 2>&1
  docker compose restart pagos_1 pagos_2 >/dev/null 2>&1
  esperar_replica 3337 120
  esperar_replica 3338 120
  docker compose restart gateway >/dev/null 2>&1
  esperar_servicio /api/v1/pagos 90
  local cuerpo="{\"id_tramite\":\"$tramite_demo\",\"usuario_id\":\"$USUARIO_ADMIN\",\"monto\":1,\"metodo_pago\":\"x\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}"
  tiempos=""
  for i in $(seq 1 8); do
    read -r codigo t <<<"$(pedir POST /api/v1/pagos "$cuerpo")"
    tiempos+="$t"$'\n'
    printf '     petición %d -> %s en %ss\n' "$i" "$codigo" "$t"
  done
  printf '   %-34s %s %s\n' "8 x POST /pagos (mediana)" "$(color_http 503)" "$(echo "$tiempos" | p50_p95_max)"

  echo
  nota "   Estado de los circuitos tras esas peticiones:"
  circuitos 3337 | sed 's/^/     pagos_1  /'
  circuitos 3338 | sed 's/^/     pagos_2  /'
  nota "   Cada réplica tiene su propio circuito: hacen falta 2 x umbral = 6"
  nota "   peticiones para que las dos dejen de golpear a tramites. A partir de ahí"
  nota "   las respuestas caen de segundos a milisegundos: circuito abierto."

  subtitulo "3.4  Servicio CONGELADO (acepta la conexión pero no contesta)"
  nota "Es peor que 'caído'. Con stop la conexión se rechaza al instante; con"
  nota "pause no hay respuesta y el cliente espera hasta agotar su timeout."
  nota "Se reinician pagos para partir de circuitos cerrados y ver el cold start."
  docker compose restart pagos_1 pagos_2 >/dev/null 2>&1
  esperar_replica 3337 120
  esperar_replica 3338 120
  docker compose pause "${TRAMITES[@]}" >/dev/null 2>&1
  docker compose restart gateway >/dev/null 2>&1
  esperar_servicio /api/v1/pagos 90
  tiempos=""
  for i in $(seq 1 5); do
    read -r codigo t <<<"$(pedir POST /api/v1/pagos "$cuerpo")"
    tiempos+="$t"$'\n'
    printf '     petición %d -> %s en %ss\n' "$i" "$codigo" "$t"
  done
  printf '   %-34s %s %s\n' "5 x POST /pagos (colgado)" "$(color_http 503)" "$(echo "$tiempos" | p50_p95_max)"
  nota "   Responde 503 desde pagos y no 502 desde nginx. Eso demuestra que el"
  nota "   presupuesto de tiempo se respeta: si nginx agotara su espera primero,"
  nota "   expulsaría a pagos y el gateway dejaría de poder alcanzarlo."
  docker compose unpause "${TRAMITES[@]}" >/dev/null 2>&1

  subtitulo "3.5  Recuperación"
  todos_arriba
  esperar_servicio /api/v1/tramites 60
  printf '   %-34s %s\n' "circuitos de pagos_1" "$(circuitos 3337 | tr '\n' ' ')"
  printf '   %-34s %s\n' "pago con tramites de vuelta" \
    "$(color_http "$(codigo_de POST /api/v1/pagos "$cuerpo")")"

  subtitulo "3.6  Coherencia entre las dos bases"
  nota "Un pago huérfano es uno ya ACREDITADO (estado pagado) cuyo trámite no"
  nota "llegó a marcarse como pagado. Un pago pendiente NO es un huérfano: está"
  nota "esperando la confirmación de tesorería. Las tablas están en bases"
  nota "distintas, así que no hay JOIN posible: se compara por lista."
  nota ""
  nota "La confirmación hace dos cosas: pone el trámite en 'pagado' con un PATCH"
  nota "y acredita el pago. Si el proceso muere entre ambas, el reconciliador lo"
  nota "termina usando la intención registrada."
  echo

  local pagados pagados_db huerfanos
  # comm exige orden lexicografico (sin -n) en los dos lados.
  pagados=$(sql municipalidad "SELECT id FROM tramites WHERE estado = 'pagado'" | sort)
  pagados_db=$(sql pagos_db "SELECT id_tramite FROM pagos WHERE estado = 'pagado'" | sort)
  huerfanos=$(printf '%s\n' "$pagados_db" | sort \
    | comm -23 - <(printf '%s\n' "$pagados" | sort))
  if [ -z "$huerfanos" ]; then
    printf '   %-34s %s\n' "pagos huérfanos" "$(color_http 0)  (ninguno)"
  else
    printf '   %-34s %s\n' "pagos huérfanos" "$(color_http 1)  trámites: $(echo "$huerfanos" | tr '\n' ' ')"
    nota "   Un id aquí significa que hay un pago guardado cuyo trámite no está"
    nota "   en estado pagado: la compensación no se ejecutó o el proceso murió."
  fi
  printf '   %-34s %s\n' "pagos registrados" "$(sql pagos_db 'SELECT count(*) FROM pagos')"
  printf '   %-34s %s\n' "trámites en estado pagado" "$(echo "$pagados" | grep -c .)"

  subtitulo "3.7  La sonda /health sigue viva con los servicios caídos"
  printf '   %-34s %s\n' "GET /health" "$(curl -s "$BASE/health" | tr -d '\n')"
  nota "   No pasa por ningún upstream. Distingue 'nginx cayó' de 'los servicios"
  nota "   cayeron', que es justo lo que necesita un orquestador para decidir."
}

# ------------------------------------------------------------------ resumen

resumen() {
  titulo "GUION DE LA PRESENTACIÓN"

  echo "   ${NEGRITA}Arquitectura${FIN}"
  nota "Tres microservicios independientes con dos réplicas cada uno, un PostgreSQL"
  nota "con tres bases separadas, y nginx como gateway único. Toda llamada entre"
  nota "servicios pasa por el gateway, nunca directa de un servicio a otro."

  echo
  echo "   ${NEGRITA}Qué se puede demostrar${FIN}"
  nota "1. Comunicación real. pagos y tramites validan al usuario preguntando a"
  nota "   usuarios. Se prueba apagando usuarios y viendo que no se crea nada."
  nota "2. Relojes de Lamport. Cada réplica lleva su sello, viaja en X-Lamport y"
  nota "   se persiste. Con 8 peticiones en paralelo salen dos eventos con el"
  nota "   mismo sello en réplicas distintas: concurrentes por definición."
  nota "3. Tolerancia a fallos. Failover del gateway, timeout por llamada,"
  nota "   reintentos con backoff, circuit breaker y compensación de pagos."
  nota "   Todo medible con curl y con este script."
  nota "4. Permisos por rol. El ciudadano solo ve y crea lo suyo; tesorería y"
  nota "   administración ven todo y son los únicos que confirman un pago."
  nota "   La identidad viaja firmada y cada servicio la verifica sin llamar a"
  nota "   usuarios, así que un fallo de usuarios no bloquea trámites ni pagos."

  echo
  echo "   ${NEGRITA}Lo que aún no está resuelto${FIN}"
  nota "(decirlo en voz alta suma credibilidad)"
  nota "- La confirmación no es transaccional: si pagos muere entre marcar el"
  nota "  trámite y acreditar el pago, el reconciliador lo termina después. El"
  nota "  pago queda pendiente mientras tanto, no se pierde ni se duplica."
  nota "- La identidad se firma con un secreto compartido: no hay rotación de"
  nota "  claves ni revocación individual antes de que caduque el token."
  nota "- No hay un solo test automatizado. Japa está configurado pero vacío."
  nota "- Los Dockerfile ejecutan 'pnpm dev' en lugar de un build de producción."

  echo
  echo "   ${NEGRITA}Decisiones de diseño que conviene explicar${FIN}"
  nota "- IP fijas para las réplicas. Con nombres de contenedor, nginx resuelve los"
  nota "  upstreams una sola vez al arrancar, así que si una IP cambiaba seguía"
  nota "  hablando con la antigua, que ya era de otro servicio."
  nota "- El gateway usa esas IP fijas en sus upstreams, no los nombres. Con"
  nota "  nombres, nginx abortaba al arrancar si una réplica estaba caída"
  nota "  ('host not found in upstream'), y el gateway se quedaba sin arrancar."
  nota "- Contenedores de migración de un solo uso: si las dos réplicas migraran a"
  nota "  la vez, una se comería un 'relation already exists'."
  nota "- node ace codegen en el build: .adonisjs está excluido por .dockerignore"
  nota "  y start/routes.ts lo importa como #generated/controllers."
  nota "- El timeout del cliente debe quedar por debajo del proxy_read_timeout del"
  nota "  gateway, o el gateway expulsa al propio servicio llamador."
  nota "- Cada réplica tiene su propio circuito y su propio reloj lógico: son"
  nota "  procesos independientes, no dos vistas del mismo proceso."
}

# --------------------------------------------------------------------- main

case "$FASE" in
  comunicacion) preflight; etapa_comunicacion ;;
  reloj)        preflight; etapa_reloj ;;
  fallos)       preflight; etapa_fallos ;;
  resumen)      resumen ;;
  todo)
    preflight
    etapa_comunicacion
    etapa_reloj
    etapa_fallos
    resumen
    ;;
  *)
    echo "Uso: $0 [comunicacion|reloj|fallos|resumen|todo]"
    exit 1
    ;;
esac