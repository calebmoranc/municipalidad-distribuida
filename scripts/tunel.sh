#!/usr/bin/env bash
#
# Levanta un túnel HTTPS temporal con Cloudflare y muestra la URL pública.
#
#   ./scripts/tunel.sh          arranca el túnel y espera la URL
#   ./scripts/tunel.sh parar    detiene el túnel
#
# La URL cambia cada vez que se reinicia. Para una URL fija hace falta un
# dominio y un túnel con nombre en Cloudflare; para la demostración basta con
# mantener este contenedor encendido.
#
# El túnel apunta al gateway, así que la interfaz y la API comparten origen:
# no hay que tocar CORS. No expongas PostgreSQL ni los microservicios.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ "${1:-}" = "parar" ]; then
  docker compose --profile tunel stop tunel >/dev/null 2>&1 || true
  docker compose --profile tunel rm -f tunel >/dev/null 2>&1 || true
  echo "Túnel detenido."
  exit 0
fi

docker compose --profile tunel up -d tunel >/dev/null

url=""
for _ in $(seq 1 30); do
  url=$(docker compose --profile tunel logs tunel 2>&1 |
    grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  [ -n "$url" ] && break
  sleep 1
done

if [ -z "$url" ]; then
  echo "No se pudo leer la URL. Revisa los logs:"
  echo "  docker compose --profile tunel logs tunel"
  exit 1
fi

echo
echo "URL HTTPS: $url/ui/"
echo
echo "La API usa el mismo origen, por ejemplo: $url/api/v1/tramites"
echo "Para detenerlo: ./scripts/tunel.sh parar"
