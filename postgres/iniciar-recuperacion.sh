#!/bin/sh
# Entrypoint de la instancia de RECUPERACION (PITR).
#
# Qué hace, en orden:
#   1. Restaura un base backup (pg_basebackup) hecho del primario.
#   2. Crea el fichero recovery.signal, que le dice a PostgreSQL que está en modo
#      recuperación: no acepta escrituras y en vez de arrancar, se reproduce el
#      WAL desde el backup hasta el instante pedido.
#   3. Arranca con restore_command para leer el WAL del volumen /archivos, y con
#      recovery_target_time para detener la reproducción en un instante exacto.
#   4. recovery_target_inclusive=off hace que la reproducción se detenga ANTES de
#      la primera transaccion igual o posterior al objetivo. Con 'on' se aplicaria
#      esa transaccion, y en una demostracion eso defeataria el proposito.
#   5. recovery_target_action=promote hace que, al alcanzar el objetivo, la base
#      pase a ser escribible y quede lista para consultarla.
#
# Si PITR_OBJETIVO viene vacío, se restaura solo el base backup (sin WAL): sirve
# para ver el estado del backup sin reproducir nada.
#
# OJO: este script corre bajo busybox ash (el /bin/sh de Alpine), no bash. Por eso
# la lista de argumentos se construye con `set --` en vez de con un array.

set -e

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
BASE_DIR=/respaldos/base

mkdir -p "$PGDATA"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "==> No hay datos en $PGDATA. Se restaura el base backup desde $BASE_DIR"
  if [ ! -f "$BASE_DIR/base.tar.gz" ]; then
    echo "ERROR: no existe $BASE_DIR/base.tar.gz"
    echo "Genéralo antes con:  ./scripts/recuperacion.sh pitr-preparar"
    exit 1
  fi

  # El base backup se extrae antes de arrancar, como root, y luego se corrigen
  # los permisos para que PostgreSQL pueda trabajar con esos ficheros.
  tar -xzf "$BASE_DIR/base.tar.gz" -C "$PGDATA"
  if [ -f "$BASE_DIR/pg_wal.tar.gz" ]; then
    mkdir -p "$PGDATA/pg_wal"
    tar -xzf "$BASE_DIR/pg_wal.tar.gz" -C "$PGDATA/pg_wal"
  fi
  chown -R postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  echo "==> Base backup restaurado"
fi

# recovery.signal es lo que activa el modo recuperación de PostgreSQL.
if [ ! -f "$PGDATA/recovery.signal" ]; then
  touch "$PGDATA/recovery.signal"
  chown postgres:postgres "$PGDATA/recovery.signal"
fi

set -- postgres \
  -c archive_mode=off \
  -c 'restore_command=cp /archivos/%f %p' \
  -c hot_standby=on \
  -c 'listen_addresses=*'

# El instante objetivo puede venir por variable de entorno o, por defecto, del
# fichero que escribe el script de pitr-destruir. Se lee del fichero porque el
# `environment:` de docker-compose tiene prioridad sobre el entorno del shell:
# poner PITR_OBJETIVO allí la sobreescribe siempre con vacío.
if [ -z "${PITR_OBJETIVO:-}" ] && [ -f /respaldos/pitr_objetivo ]; then
  PITR_OBJETIVO=$(cat /respaldos/pitr_objetivo)
fi

if [ -n "${PITR_OBJETIVO:-}" ]; then
  echo "==> Recuperando hasta el instante: $PITR_OBJETIVO"
  set -- "$@" \
    -c "recovery_target_time=$PITR_OBJETIVO" \
    -c recovery_target_inclusive=off \
    -c recovery_target_action=promote
else
  echo "==> Sin PITR_OBJETIVO: se restaura solo el base backup"
fi

echo "==> Arrancando PostgreSQL en modo recuperación"
exec docker-entrypoint.sh "$@"