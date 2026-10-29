#!/bin/sh
# Crea las bases de datos que usan los servicios, de forma idempotente.
#
# El contenedor de postgres SÓLO crea la base de POSTGRES_DB, y sus scripts de
# /docker-entrypoint-initdb.d/ únicamente se ejecutan cuando el volumen está
# vacío. Por eso esto vive en un servicio aparte: así funciona en cada
# `docker compose up`, tenga el volumen lo que tenga.
#
# OJO: no usar \gexec con `psql -c`, porque psql manda la cadena entera al
# servidor como una sola consulta y el servidor no entiende los meta-comandos.
# PGHOST se deja VACÍO a propósito cuando no viene definido, porque vacío en
# libpq significa "usar el socket local". Si el valor por defecto fuera 'postgres',
# este script conectado desde DENTRO de un contenedor de PostgreSQL resolvería
# ese nombre al servidor principal y no crearía nada aquí. El servicio db_init sí
# define PGHOST=postgres, y en ese caso sí queremos el primario.
set -e

PGHOST="${PGHOST-}"
PGUSER="${PGUSER:-municipalidad}"
PGDATABASE="${PGDATABASE:-municipalidad}"

psql_query() {
  psql -v ON_ERROR_STOP=1 --host "$PGHOST" --username "$PGUSER" --dbname "$PGDATABASE" "$@"
}

for db in usuarios_db pagos_db; do
  exists=$(psql_query --tuples-only --no-align \
    --command "SELECT 1 FROM pg_database WHERE datname = '$db'")

  if [ "$exists" = "1" ]; then
    echo "==> La base $db ya existe, se deja como está"
  else
    echo "==> Creando base de datos: $db"
    psql_query --command "CREATE DATABASE \"$db\""
    echo "==> Base $db creada"
  fi
done

echo "==> Bases de datos listas"