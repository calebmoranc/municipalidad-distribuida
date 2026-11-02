#!/usr/bin/env bash

set -uo pipefail

cd "$(dirname "$0")/.."

FALLOS=0
ADVERTENCIAS=0

ok() {
  printf 'OK    %s\n' "$1"
}

fallo() {
  printf 'FALLA %s\n' "$1"
  FALLOS=$((FALLOS + 1))
}

aviso() {
  printf 'AVISO %s\n' "$1"
  ADVERTENCIAS=$((ADVERTENCIAS + 1))
}

for comando in docker git curl jq openssl; do
  if command -v "$comando" >/dev/null 2>&1; then
    ok "$comando"
  else
    fallo "falta $comando"
  fi
done

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose v2"
  else
    fallo "falta el plugin docker compose v2"
  fi

  if docker info >/dev/null 2>&1; then
    ok "demonio Docker"
  else
    fallo "el demonio Docker no responde"
  fi
fi

PRIMER_SECRETO=""
for servicio in usuarios tramites pagos; do
  archivo="$servicio/.env"

  if [ ! -f "$archivo" ]; then
    fallo "falta $archivo; ejecuta ./scripts/preparar_entorno.sh"
    continue
  fi

  if grep -qE '^APP_KEY=.+' "$archivo"; then
    ok "$archivo APP_KEY"
  else
    fallo "$archivo tiene APP_KEY vacío"
  fi

  if grep -qE '^AUTH_IDENTITY_SECRET=.+' "$archivo"; then
    ok "$archivo AUTH_IDENTITY_SECRET"
    valor="$(awk -F= '$1 == "AUTH_IDENTITY_SECRET" { sub(/^[^=]*=/, ""); print; exit }' "$archivo")"
    if [ -z "$PRIMER_SECRETO" ]; then
      PRIMER_SECRETO="$valor"
    elif [ "$valor" != "$PRIMER_SECRETO" ]; then
      aviso "$archivo usa un AUTH_IDENTITY_SECRET distinto"
    fi
  else
    fallo "$archivo no tiene AUTH_IDENTITY_SECRET"
  fi
done

if command -v ping >/dev/null 2>&1; then
  ok "ping"
else
  aviso "falta ping; en Ubuntu/WSL: sudo apt install iputils-ping"
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if docker compose config -q >/dev/null 2>&1; then
    ok "docker-compose.yml válido"
  else
    fallo "docker compose config falla; revisa los .env y el compose"
  fi
fi

if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -qE '(:8080[[:space:]])'; then
    aviso "el puerto 8080 ya está en uso; puede que el stack ya esté levantado"
  fi
fi

echo
if [ "$FALLOS" -eq 0 ]; then
  echo "Entorno listo."
  echo "Siguiente: docker compose up -d --build"
  exit 0
fi

echo "Hay $FALLOS problema(s) y $ADVERTENCIAS advertencia(s)."
echo "Corrige los FALLA y vuelve a ejecutar este script."
exit 1
