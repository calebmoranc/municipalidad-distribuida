#!/usr/bin/env bash
#
# Recuperación ante fallos: respaldos lógicos y recuperación en el tiempo (PITR).
#
#   ./scripts/recuperacion.sh info            estado actual y qué hay archivado
#   ./scripts/recuperacion.sh backup          copia las 3 bases a respaldos/
#   ./scripts/recuperacion.sh restaurar       restaura el último backup en la
#                                            instancia postgres_respaldo
#   ./scripts/recuperacion.sh comparar        compara original vs restaurado
#   ./scripts/recuperacion.sh demo-backup     borra datos a propósito, restaura
#                                            el primario y comprueba que volvieron
#   ./scripts/recuperacion.sh recuperar-primario  restaura el primario del último backup
#   ./scripts/recuperacion.sh pitr-preparar   base backup + WAL (para el PITR)
#   ./scripts/recuperacion.sh pitr-destruir   simula el desastre en el primario
#   ./scripts/recuperacion.sh pitr-recuperar  restaura hasta el instante pedido
#   ./scripts/recuperacion.sh pitr-verificar  consulta la instancia recuperada
#   ./scripts/recuperacion.sh pitr-limpiar    borra la instancia de recuperación
#
# Requisitos: docker, docker compose, curl.

set -uo pipefail

cd "$(dirname "$0")/.."

DIR_RESPALDOS="respaldos"
DIR_BASE="$DIR_RESPALDOS/base"
MARCADOR="demo-respaldo"   # marca en 'tipo_detalle' para no tocar datos reales
BASES=(municipalidad usuarios_db pagos_db)
ANTIG=5   # segundos que el reconciliador espera antes de tocar una intención

NEGRITA=$'\033[1m'
FIN=$'\033[0m'
VERDE=$'\033[0;32m'
ROJO=$'\033[0;31m'
AMBAR=$'\033[0;33m'
GRIS=$'\033[0;90m'

titulo() { printf '\n%s%s%s\n' "$NEGRITA" "$(printf '=%.0s' $(seq 1 74))" "$FIN"; }
sub() { printf '\n%s%s%s\n' "$NEGRITA" "$1" "$FIN"; }
nota() { printf '   %s%s%s\n' "$GRIS" "$1" "$FIN"; }

# ------------------------------------------------------------------- consultas

sql() {
  # sql <base-de-datos> <consulta>
  docker compose exec -T postgres psql -U municipalidad -d "$1" -tAc "$2" 2>/dev/null | tr -d '\r'
}

contar_tramites() { sql municipalidad "SELECT count(*) FROM tramites"; }
contar_demo() { sql municipalidad "SELECT count(*) FROM tramites WHERE tipo_detalle='$MARCADOR'"; }

# Cuerpo JSON del login de administrador (incluye la identidad firmada).
login_admin() {
  curl -s --max-time 20 -X POST http://localhost:8080/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@municipalidad.gob","password":"Municipal123"}'
}

# Consulta a la instancia de RECUPERACION (localhost:55433).
sql_rec() {
  docker compose --profile recuperacion exec -T postgres_recuperacion \
    psql -U municipalidad -d "$1" -tAc "$2" 2>/dev/null | tr -d '\r'
}

# ------------------------------------------------------------------- respaldos

cmd_info() {
  titulo "ESTADO DE LA RECUPERACIÓN"

  sub "Bases de datos del primario"
  for db in "${BASES[@]}"; do
    printf '   %-14s %s tablas\n' "$db" \
      "$(sql "$db" "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
  done

  sub "Trámites"
  printf '   total: %s   de prueba (%s): %s\n' "$(contar_tramites)" "$MARCADOR" "$(contar_demo)"

  sub "WAL archivado (lo que permite el PITR)"
  local archivos tamano
  archivos=$(docker compose exec -T postgres sh -c 'ls -1 /archivos 2>/dev/null | wc -l' 2>/dev/null | tr -d '\r')
  tamano=$(docker compose exec -T postgres sh -c 'du -sh /archivos 2>/dev/null | cut -f1' 2>/dev/null | tr -d '\r')
  printf '   %s archivos, %s\n' "${archivos:-0}" "${tamano:-0}"

  sub "Base backup para PITR"
  if [ -f "$DIR_BASE/base.tar.gz" ]; then
    printf '   %s (%s)\n' "$DIR_BASE/base.tar.gz" "$(du -h "$DIR_BASE/base.tar.gz" | cut -f1)"
  else
    printf '   no existe todavía (usa: %s pitr-preparar)\n' "$0"
  fi

  sub "Backups lógicos"
  if ls "$DIR_RESPALDOS"/*.dump >/dev/null 2>&1; then
    ls -la "$DIR_RESPALDOS"/*.dump | awk '{printf "   %-46s %s\n", $9, $5}'
  else
    printf '   ninguno todavía (usa: %s backup)\n' "$0"
  fi

  sub "Instancia de respaldo (perfil 'respaldo')"
  if docker ps --format '{{.Names}}' | grep -q postgres_respaldo; then
    printf '   levantada en localhost:55432\n'
  else
    printf '   apagada (usa: %s restaurar)\n' "$0"
  fi

  sub "Instancia de recuperación (perfil 'recuperacion')"
  if docker ps --format '{{.Names}}' | grep -q postgres_recuperacion; then
    printf '   levantada en localhost:55433\n'
  else
    printf '   apagada\n'
  fi
}

cmd_backup() {
  titulo "BACKUP LÓGICO"

  mkdir -p "$DIR_RESPALDOS"
  local marca db archivo
  marca=$(date +%Y%m%d_%H%M%S)
  echo "$marca" >"$DIR_RESPALDOS/ULTIMO"

  echo
  printf '   %-14s %-12s %s\n' "base" "tamaño" "archivo"
  for db in "${BASES[@]}"; do
    archivo="$DIR_RESPALDOS/${db}_${marca}.dump"
    # -Fc es el formato "custom": comprimido y restaurable en paralelo con pg_restore.
    if docker compose exec -T postgres pg_dump -U municipalidad -Fc -d "$db" >"$archivo" 2>/dev/null; then
      printf '   %-14s %-12s %s\n' "$db" "$(du -h "$archivo" | cut -f1)" "$archivo"
    else
      printf '   %-14s %s\n' "$db" "ERROR al respaldar"
      return 1
    fi
  done

  # Suma de verificacion: sirve para saber que el archivo no se corrompió.
  (cd "$DIR_RESPALDOS" && sha256sum ./*.dump >sumas.sha256)
  echo
  nota "Sumas de verificación en $DIR_RESPALDOS/sumas.sha256"
  nota "Comprobarlas con:  cd $DIR_RESPALDOS && sha256sum -c sumas.sha256"
}

# Espera a que la instancia esté REALMENTE lista.
#
# No sirve con `pg_isready`: durante la inicialización el entrypoint levanta un
# servidor temporal que acepta conexiones y luego lo detiene para arrancar el
# definitivo. Si nos enganchamos a ese, pg_restore falla con
# "terminating connection due to administrator command". Por eso se espera al
# estado de salud del contenedor y a que las tres bases existan.
esperar_respaldo() {
  local id i estado
  id=$(docker compose --profile respaldo ps -q postgres_respaldo 2>/dev/null)
  [ -n "$id" ] || return 1

  for ((i = 0; i < 90; i += 2)); do
    estado=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null)
    if [ "$estado" = "healthy" ]; then
      local creadas
      creadas=$(docker compose --profile respaldo exec -T postgres_respaldo \
        psql -U municipalidad -d postgres -tAc \
        "SELECT count(*) FROM pg_database WHERE datname IN ('municipalidad','usuarios_db','pagos_db')" \
        2>/dev/null | tr -d '\r')
      [ "$creadas" = "3" ] && return 0
    fi
    sleep 2
  done
  return 1
}

cmd_restaurar() {
  titulo "RESTAURAR EN LA INSTANCIA DE RESPALDO"

  local ultimo
  ultimo=$(cat "$DIR_RESPALDOS/ULTIMO" 2>/dev/null)
  if [ -z "$ultimo" ]; then
    echo "   No hay backups. Ejecuta antes: $0 backup"
    return 1
  fi

  sub "Levantando la instancia de respaldo (localhost:55432)"
  docker compose --profile respaldo up -d postgres_respaldo >/dev/null 2>&1

  if ! esperar_respaldo; then
    printf '   %sLa instancia de respaldo no quedó lista.%s\n' "$ROJO" "$FIN"
    nota "Logs:  docker compose --profile respaldo logs postgres_respaldo"
    return 1
  fi
  echo "   instancia lista"

  sub "Restaurando las bases del backup $ultimo"
  local db archivo salida intento ok
  for db in "${BASES[@]}"; do
    archivo="$DIR_RESPALDOS/${db}_${ultimo}.dump"
    if [ ! -f "$archivo" ]; then
      printf '   %-14s sin archivo de backup\n' "$db"
      continue
    fi

    ok=0
    for intento in 1 2 3; do
      salida=$(docker compose --profile respaldo exec -T postgres_respaldo \
        pg_restore -U municipalidad -d "$db" --clean --if-exists --no-owner --exit-on-error <"$archivo" 2>&1)
      if [ $? -eq 0 ]; then
        ok=1
        break
      fi
      sleep 3
    done

    if [ "$ok" -eq 1 ]; then
      printf '   %-14s restaurada\n' "$db"
    else
      printf '   %-14s %sFALLÓ:%s %s\n' "$db" "$ROJO" "$FIN" \
        "$(echo "$salida" | tr '\n' ' ' | cut -c1-90)"
    fi
  done
}

cmd_comparar() {
  titulo "COMPARAR ORIGINAL vs RESPALDO"

  local db o r o_txt r_txt
  printf '   %-14s %-14s %-14s %s\n' "consulta" "original" "respaldo" "estado"
  o=$(sql municipalidad 'SELECT count(*) FROM tramites')
  r=$(docker compose --profile respaldo exec -T postgres_respaldo psql -U municipalidad -d municipalidad -tAc 'SELECT count(*) FROM tramites' 2>/dev/null | tr -d '\r')
  if [ "$o" = "$r" ]; then estado="${VERDE}igual${FIN}"; else estado="${ROJO}distinto${FIN}"; fi
  printf '   %-14s %-14s %-14s %b\n' "trámites" "$o" "${r:-?}" "$estado"

  o=$(sql usuarios_db 'SELECT count(*) FROM users')
  r=$(docker compose --profile respaldo exec -T postgres_respaldo psql -U municipalidad -d usuarios_db -tAc 'SELECT count(*) FROM users' 2>/dev/null | tr -d '\r')
  if [ "$o" = "$r" ]; then estado="${VERDE}igual${FIN}"; else estado="${ROJO}distinto${FIN}"; fi
  printf '   %-14s %-14s %-14s %b\n' "usuarios" "$o" "${r:-?}" "$estado"

  o=$(sql pagos_db 'SELECT count(*) FROM pagos')
  r=$(docker compose --profile respaldo exec -T postgres_respaldo psql -U municipalidad -d pagos_db -tAc 'SELECT count(*) FROM pagos' 2>/dev/null | tr -d '\r')
  if [ "$o" = "$r" ]; then estado="${VERDE}igual${FIN}"; else estado="${ROJO}distinto${FIN}"; fi
  printf '   %-14s %-14s %-14s %b\n' "pagos" "$o" "${r:-?}" "$estado"
}

cmd_recuperar_primario() {
  titulo "RECUPERAR EL PRIMARIO DESDE EL BACKUP"

  local ultimo
  ultimo=$(cat "$DIR_RESPALDOS/ULTIMO" 2>/dev/null)
  if [ -z "$ultimo" ]; then
    echo "   No hay backups. Ejecuta antes: $0 backup"
    return 1
  fi

  sub "Deteniendo los servicios para que no escriban durante la restauración"
  docker compose stop usuarios_1 usuarios_2 tramites_1 tramites_2 pagos_1 pagos_2 >/dev/null 2>&1
  echo "   servicios detenidos"

  sub "Restaurando en el primario el backup $ultimo"
  local db archivo salida ok intento
  for db in "${BASES[@]}"; do
    archivo="$DIR_RESPALDOS/${db}_${ultimo}.dump"
    if [ ! -f "$archivo" ]; then
      printf '   %-14s sin archivo de backup\n' "$db"
      continue
    fi

    ok=0
    for intento in 1 2 3; do
      salida=$(docker compose exec -T postgres pg_restore -U municipalidad -d "$db" \
        --clean --if-exists --no-owner --exit-on-error <"$archivo" 2>&1)
      if [ $? -eq 0 ]; then
        ok=1
        break
      fi
      sleep 3
    done

    if [ "$ok" -eq 1 ]; then
      printf '   %-14s restaurada\n' "$db"
    else
      printf '   %-14s %sFALLÓ:%s %s\n' "$db" "$ROJO" "$FIN" \
        "$(echo "$salida" | tr '\n' ' ' | cut -c1-90)"
    fi
  done

  sub "Volviendo a levantar los servicios"
  docker compose up -d >/dev/null 2>&1
  local i
  for ((i = 0; i < 60; i += 2)); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:8080/health)" = "200" ] && break
    sleep 2
  done
  echo "   servicios en marcha"
}

cmd_demo_backup() {
  titulo "DEMOSTRACIÓN: PERDER DATOS Y RECUPERARLOS"

  sub "1. Se crean datos que vamos a perder"
  local sesion identidad usuario_id
  sesion=$(login_admin)
  identidad=$(printf '%s' "$sesion" | jq -r '.data.identidad // empty')
  usuario_id=$(printf '%s' "$sesion" | jq -r '.data.user.id // "10000001"')

  local i
  for ((i = 1; i <= 5; i++)); do
    curl -s -o /dev/null -X POST http://localhost:8080/api/v1/tramites \
      -H 'Content-Type: application/json' -H "X-Identidad: $identidad" \
      -d "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"$MARCADOR\",\"monto\":1000,\"descripcion\":\"dato de prueba $i\"}"
  done
  printf '   trámites de prueba creados: %s\n' "$(contar_demo)"

  sub "2. Se hace el backup"
  cmd_backup

  sub "3. Se pierden los datos a propósito"
  sql municipalidad "DELETE FROM tramites WHERE tipo_detalle='$MARCADOR'" >/dev/null
  printf '   %sBorrados. Ahora quedan %s trámites de prueba.%s\n' "$ROJO" "$(contar_demo)" "$FIN"
  printf '   El servicio ya no los tiene: GET /api/v1/tramites devuelve %s.\n' "$(contar_tramites)"

  sub "4. Se recupera el primario desde el backup"
  cmd_recuperar_primario

  sub "5. Comprobación"
  printf '   trámites de prueba en el primario: %s\n' "$(contar_demo)"
  if [ "$(contar_demo)" -ge 5 ]; then
    printf '   %sLos datos volvieron.%s\n' "$VERDE" "$FIN"
  else
    printf '   %sNo volvieron como se esperaba.%s\n' "$ROJO" "$FIN"
  fi

  echo
  nota "Los backups también se pueden restaurar en una instancia aparte, sin tocar"
  nota "el servicio, para comprobar que el archivo sirve:"
  nota "  $0 restaurar && $0 comparar     (instancia en localhost:55432)"
}

# ----------------------------------------------------------------------- PITR

cmd_pitr_preparar() {
  titulo "PITR (1/3) — BASE BACKUP"

  mkdir -p "$DIR_BASE"

  sub "Forzando el archivado del WAL actual"
  sql postgres 'SELECT pg_switch_wal()' >/dev/null
  sleep 2

  sub "Base backup del primario"
  # -Ft formato tar (lo sabemos desempaquetar con tar), -X stream incluye el WAL
  # necesario para dejar la copia consistente, -z comprimido.
  if docker compose exec -T postgres sh -c \
    'pg_basebackup -U municipalidad -D /tmp/base -Ft -z -X stream -c fast' >/dev/null 2>&1; then

    for f in base.tar.gz pg_wal.tar.gz tablespace_map; do
      if docker compose exec -T postgres test -f "/tmp/base/$f" 2>/dev/null; then
        docker cp "$(docker compose ps -q postgres):/tmp/base/$f" "$DIR_BASE/$f" 2>/dev/null
      fi
    done
    docker compose exec -T postgres rm -rf /tmp/base >/dev/null 2>&1

    if [ -f "$DIR_BASE/base.tar.gz" ]; then
      printf '   %sbase backup creado: %s (%s)%s\n' "$VERDE" "$DIR_BASE/base.tar.gz" \
        "$(du -h "$DIR_BASE/base.tar.gz" | cut -f1)" "$FIN"
    else
      printf '   %sNo se pudo copiar el base backup.%s\n' "$ROJO" "$FIN"
      return 1
    fi
  else
    printf '   %sfallo pg_basebackup%s\n' "$ROJO" "$FIN"
    return 1
  fi

  nota "Un backup lógico (pg_dump) sirve para volver al estado de HOY."
  nota "El base backup + WAL es lo que permite volver a un instante exacto."
}

cmd_pitr_destruir() {
  titulo "PITR (2/3) — EL DESASTRE"

  # Instante al que queremos volver. Se guarda ANTES de destruir nada, y en el
  # formato 'YYYY-MM-DDTHH:MM:SS.MS' porque es el que recovery_target_time
  # entiende. Con milisegundos hace falta: si se trunca al segundo, la
  # transaction del desastre cae dentro del mismo segundo y SÍ se recupera.
  # (El formato de to_char(now()) con +00 NO lo acepta PostgreSQL, de ahí el
  # to_char explícito.)
  local objetivo
  objetivo=$(docker compose exec -T postgres psql -U municipalidad -d postgres -tAc \
    "SELECT to_char(now(), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS')" 2>/dev/null | tr -d '\r')
  printf '%s\n' "$objetivo" >"$DIR_RESPALDOS/pitr_objetivo"

  sub "Instante guardado: la recuperación volverá aquí"
  printf '   %s\n' "$objetivo"
  nota "PostgreSQL corre en UTC, así que este es el instante en UTC."

  sub "Ahora sí: se destruye información en el primario"
  sql municipalidad "CREATE TABLE IF NOT EXISTS tabla_desastre (id serial primary key, nota text)" >/dev/null
  sql municipalidad "INSERT INTO tabla_desastre (nota) VALUES ('esta fila se creo DESPUES del punto de recuperacion')" >/dev/null
  printf '   %sTabla tabla_desastre creada con una fila.%s\n' "$ROJO" "$FIN"
  printf '   Trámites en el primario: %s\n' "$(contar_tramites)"

  # Se fuerza el archivado para que el desastre quede escrito en el WAL.
  sql postgres 'SELECT pg_switch_wal()' >/dev/null
  sleep 2

  printf '\n   %sEl primario ya tiene datos que NO existían en el instante guardado.%s\n' "$AMBAR" "$FIN"
  printf '   Para volver atrás:  %s pitr-recuperar\n' "$0"
}

cmd_pitr_recuperar() {
  titulo "PITR (3/3) — RECUPERAR HASTA EL INSTANTE GUARDADO"

  local objetivo
  objetivo=$(cat "$DIR_RESPALDOS/pitr_objetivo" 2>/dev/null)
  if [ -z "$objetivo" ]; then
    echo "   No hay instante guardado. Ejecuta antes: $0 pitr-destruir"
    return 1
  fi
  if [ ! -f "$DIR_BASE/base.tar.gz" ]; then
    echo "   No hay base backup. Ejecuta antes: $0 pitr-preparar"
    return 1
  fi

  printf '   Instante objetivo: %s\n' "$objetivo"

  sub "Arrancando la instancia de recuperación (localhost:55433)"
  docker compose --profile recuperacion rm -sf postgres_recuperacion >/dev/null 2>&1
  docker compose --profile recuperacion stop postgres_recuperacion >/dev/null 2>&1
  docker volume rm "$(docker volume ls -q | grep recuperacion_data | head -1)" >/dev/null 2>&1

  PITR_OBJETIVO="$objetivo" docker compose --profile recuperacion up -d postgres_recuperacion >/dev/null 2>&1

  echo "   PostgreSQL está reproduciendo el WAL. esperando..."
  local i ok=0
  for ((i = 0; i < 90; i += 2)); do
    if docker compose --profile recuperacion exec -T postgres_recuperacion \
      pg_isready -U municipalidad -q >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 2
  done

  if [ "$ok" -ne 1 ]; then
    printf '   %sLa instancia de recuperación no respondió.%s\n' "$ROJO" "$FIN"
    nota "Mira sus logs:  docker compose logs postgres_recuperacion"
    return 1
  fi

  # Puede tardar un poco más en terminar de promoverla.
  for ((i = 0; i < 30; i += 2)); do
    docker compose --profile recuperacion exec -T postgres_recuperacion \
      psql -U municipalidad -d municipalidad -tAc 'SELECT 1' >/dev/null 2>&1 && break
    sleep 2
  done

  printf '   %sRecuperación terminada.%s\n' "$VERDE" "$FIN"
  printf '   Para consultar:  %s pitr-verificar\n' "$0"
}

cmd_pitr_verificar() {
  titulo "QUÉ SE RECUPERÓ Y QUÉ NO"

  sub "Instancia recuperada (localhost:55433)"
  printf '   trámites:              %s\n' "$(sql_rec municipalidad 'SELECT count(*) FROM tramites')"
  printf '   usuarios:              %s\n' "$(sql_rec usuarios_db 'SELECT count(*) FROM users')"
  printf '   pagos:                 %s\n' "$(sql_rec pagos_db 'SELECT count(*) FROM pagos')"

  sub "¿Existe la tabla creada DESPUÉS del instante de recuperación?"
  local existe
  existe=$(sql_rec municipalidad "SELECT count(*) FROM pg_tables WHERE tablename='tabla_desastre'")
  if [ "$existe" = "0" ]; then
    printf '   %sNO existe.%s  El estado vuelve al instante pedido.\n' "$VERDE" "$FIN"
  else
    printf '   %sSí existe.%s  La recuperación fue más allá del objetivo.\n' "$ROJO" "$FIN"
  fi

  sub "Instancia original (el primario sigue vivo y tiene el desastre)"
  printf '   trámites:              %s\n' "$(contar_tramites)"
  printf '   tabla_desastre existe: %s\n' "$(sql municipalidad "SELECT count(*) FROM pg_tables WHERE tablename='tabla_desastre'")"

  nota "Este es el punto clave del PITR: no se restauró 'el último backup',"
  nota "se reprodujo el WAL hasta un instante y se paró ahí."
}

cmd_pitr_limpiar() {
  titulo "LIMPIAR LA INSTANCIA DE RECUPERACIÓN"
  docker compose --profile recuperacion rm -sf postgres_recuperacion >/dev/null 2>&1
  echo "   instancia de recuperación eliminada (su volumen también)"
  rm -rf "$DIR_BASE"
  rm -f "$DIR_RESPALDOS"/pitr_*
  echo "   base backup y marcas de PITR borrados"
}

# ---------------------------------------------------------------- SAGA

# SQL directo a pagos_db, que es donde viven los pagos y las intenciones.
sql_pagos() {
  docker compose exec -T postgres psql -U municipalidad -d pagos_db -tAc "$1" 2>/dev/null | tr -d '\r'
}

cmd_saga() {
  titulo "SAGA: UNA OPERACIÓN INTERRUMPIDA SE RECUPERA"

  nota "Se registra una solicitud de pago y se confirma. El proceso de pagos muere"
  nota "DESPUÉS de guardar la intención pero ANTES de avisar al servicio de"
  nota "trámites. Esa es la ventana que antes dejaba el sistema con un pago"
  nota "huérfano y sin registro de nada."

  local sesion identidad usuario_id
  sesion=$(login_admin)
  identidad=$(printf '%s' "$sesion" | jq -r '.data.identidad // empty')
  usuario_id=$(printf '%s' "$sesion" | jq -r '.data.user.id // empty')

  if [ -z "$identidad" ] || [ -z "$usuario_id" ]; then
    printf '   %sNo se pudo iniciar sesión como administrador. ¿Está el stack arriba?%s\n' "$ROJO" "$FIN"
    return 1
  fi

  # 1. Se necesita un trámite.
  sub "1. Se crea un trámite"
  local tramite
  tramite=$(curl -s -X POST http://localhost:8080/api/v1/tramites \
    -H 'Content-Type: application/json' -H "X-Identidad: $identidad" \
    -d "{\"usuarioId\":\"$usuario_id\",\"tipo\":\"Otro\",\"tipoDetalle\":\"saga\",\"monto\":7777,\"descripcion\":\"pago que se va a interrumpir\"}" \
    | jq -r '.id' 2>/dev/null)

  if [ -z "$tramite" ] || [ "$tramite" = "null" ]; then
    printf '   %sNo se pudo crear el trámite. ¿Está el stack arriba?%s\n' "$ROJO" "$FIN"
    return 1
  fi
  printf '   trámite id=%s\n' "$tramite"

  # 2. Se apaga pagos_2 para que todo el tráfico vaya a una sola réplica.
  sub "2. Se deja una sola réplica de pagos, con el fallo activado"
  docker compose stop pagos_2 >/dev/null 2>&1
  PAGOS_FALLAR_ANTES_DE_PATCH=1 docker compose up -d pagos_1 >/dev/null 2>&1
  local i
  for ((i = 0; i < 60; i += 2)); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 localhost:3337/)" = "200" ] && break
    sleep 2
  done
  echo "   pagos_1 arriba y con PAGOS_FALLAR_ANTES_DE_PATCH=1"

  # 3. La solicitud: nace pendiente y no toca trámites.
  sub "3. Se registra la solicitud de pago"
  local pago_id
  pago_id=$(curl -s --max-time 30 -X POST http://localhost:8080/api/v1/pagos \
    -H 'Content-Type: application/json' -H "X-Identidad: $identidad" \
    -d "{\"id_tramite\":\"$tramite\",\"usuario_id\":\"$usuario_id\",\"monto\":7777,\"metodo_pago\":\"tarjeta\",\"fecha_pago\":\"2026-01-15T10:00:00Z\"}" \
    | jq -r '.idPago // empty')

  if [ -z "$pago_id" ] || [ "$pago_id" = "null" ]; then
    printf '   %sNo se pudo registrar el pago.%s\n' "$ROJO" "$FIN"
    docker compose up -d >/dev/null 2>&1
    return 1
  fi
  printf '   pago id=%s   estado=%s\n' "$pago_id" \
    "$(sql_pagos "SELECT estado FROM pagos WHERE id_pago='$pago_id'")"

  # 4. La confirmación es la que muere en la ventana de la saga.
  sub "4. Se confirma el pago: el proceso muere en mitad de la operación"
  local codigo
  codigo=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
    -X POST "http://localhost:8080/api/v1/pagos/$pago_id/confirmar" \
    -H "X-Identidad: $identidad")
  printf '   HTTP %s   (000 = el proceso murió en mitad de la operación)\n' "$codigo"

  # 5. El estado inconsistente
  sub "5. ESTADO TRAS LA INTERRUPCIÓN"
  printf '   %spago guardado:        %s%s\n' "$AMBAR" "$(sql_pagos "SELECT count(*) FROM pagos WHERE id_tramite='$tramite'")" "$FIN"
  printf '   %sestado del pago:      %s%s\n' "$AMBAR" "$(sql_pagos "SELECT estado FROM pagos WHERE id_pago='$pago_id'")" "$FIN"
  printf '   %sestado del trámite:   %s%s\n' "$AMBAR" "$(sql municipalidad "SELECT estado FROM tramites WHERE id='$tramite'")" "$FIN"
  printf '   %sintención registrada: %s%s\n' "$AMBAR" "$(sql_pagos "SELECT coalesce(string_agg(estado, ','), 'ninguna') FROM pagos_intentos WHERE id_tramite='$tramite'")" "$FIN"
  nota "El pago está guardado pero el trámite no está pagado: el sistema quedó"
  nota "a medio camino. La intención quedó registrada, y eso es lo que permite"
  nota "que otro proceso sepa qué hacer."

  # 6. Recuperación: se levanta pagos sin el fallo
  sub "6. Se reinicia pagos sin el fallo: arranca el reconciliador"
  docker compose up -d pagos_1 >/dev/null 2>&1
  docker compose start pagos_2 >/dev/null 2>&1
  nota "El reconciliador espera $ANTIG segundos antes de actuar, por si el proceso"
  nota "anterior solo estaba lento y no muerto."

  local espera
  for ((espera = ANTIG + 4; espera <= ANTIG + 40; espera += 3)); do
    sleep 3
    local estado
    estado=$(sql_pagos "SELECT coalesce(max(estado), 'ninguna') FROM pagos_intentos WHERE id_tramite='$tramite'")
    [ "$estado" != "pendiente" ] && break
  done

  sub "7. ESTADO TRAS LA RECUPERACIÓN"
  local pagos_tramite estado_tramite estado_pago estado_intento
  pagos_tramite=$(sql_pagos "SELECT count(*) FROM pagos WHERE id_tramite='$tramite'")
  estado_pago=$(sql_pagos "SELECT estado FROM pagos WHERE id_pago='$pago_id'")
  estado_tramite=$(sql municipalidad "SELECT estado FROM tramites WHERE id='$tramite'")
  estado_intento=$(sql_pagos "SELECT coalesce(max(estado), 'ninguna') FROM pagos_intentos WHERE id_tramite='$tramite'")

  printf '   pago guardado:        %s\n' "$pagos_tramite"
  printf '   estado del pago:      %s\n' "$estado_pago"
  printf '   estado del trámite:   %s\n' "$estado_tramite"
  printf '   intención:            %s\n' "$estado_intento"

  if [ "$estado_tramite" = "pagado" ] && [ "$estado_pago" = "pagado" ] && [ "$estado_intento" = "confirmado" ]; then
    printf '\n   %sRECUPERACIÓN COMPLETA: el otro proceso terminó el trabajo.%s\n' "$VERDE" "$FIN"
  elif [ "$pagos_tramite" = "0" ] && [ "$estado_intento" = "revertido" ]; then
    printf '\n   %sRECUPERACIÓN COMPLETA: el pago se deshizo y no quedó nada a medias.%s\n' "$VERDE" "$FIN"
  else
    printf '\n   %sEl sistema sigue a medio camino: vuelve a mirar en unos segundos.%s\n' "$AMBAR" "$FIN"
    nota "   Puedes forzar otra pasada con:"
    nota "     curl -X POST http://localhost:8080/api/v1/intentos/reconciliar"
  fi

  sub "Historial de intenciones"
  curl -s http://localhost:8080/api/v1/intentos 2>/dev/null | jq -r '.ultimos[0:3][] | "   #\(.id)  \(.estado)  pago=\(.pagoId)  \(.ultimoError // "-")"' 2>/dev/null

  docker compose up -d >/dev/null 2>&1
}

case "${1:-info}" in
  info) cmd_info ;;
  backup) cmd_backup ;;
  restaurar) cmd_restaurar ;;
  comparar) cmd_comparar ;;
  demo-backup) cmd_demo_backup ;;
  recuperar-primario) cmd_recuperar_primario ;;
  saga) cmd_saga ;;
  pitr-preparar) cmd_pitr_preparar ;;
  pitr-destruir) cmd_pitr_destruir ;;
  pitr-recuperar) cmd_pitr_recuperar ;;
  pitr-verificar) cmd_pitr_verificar ;;
  pitr-limpiar) cmd_pitr_limpiar ;;
  *)
    echo "Uso: $0 {info|backup|restaurar|comparar|demo-backup|recuperar-primario|saga|pitr-preparar|pitr-destruir|pitr-recuperar|pitr-verificar|pitr-limpiar}"
    exit 1
    ;;
esac

# ----------------------------------------------------------------------- main
