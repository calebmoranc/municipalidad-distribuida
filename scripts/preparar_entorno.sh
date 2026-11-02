#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

FORZAR=0
if [ "${1:-}" = "--force" ]; then
  FORZAR=1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "Falta openssl. En Ubuntu/WSL: sudo apt install openssl" >&2
  exit 1
fi

SECRETO="${AUTH_IDENTITY_SECRET:-municipalidad-identidad-dev}"

valor_actual() {
  local archivo="$1"
  local clave="$2"

  awk -F= -v clave="$clave" '$1 == clave { sub(/^[^=]*=/, ""); print; exit }' "$archivo"
}

actualizar_valor() {
  local archivo="$1"
  local clave="$2"
  local valor="$3"
  local temporal

  temporal="$(mktemp)"
  awk -v clave="$clave" -v valor="$valor" '
    $0 ~ "^" clave "=" { print clave "=" valor; hecho = 1; next }
    { print }
    END { if (!hecho) print clave "=" valor }
  ' "$archivo" > "$temporal"
  mv "$temporal" "$archivo"
}

for servicio in usuarios tramites pagos; do
  ejemplo="$servicio/.env.example"
  destino="$servicio/.env"

  if [ ! -f "$ejemplo" ]; then
    echo "Falta $ejemplo" >&2
    exit 1
  fi

  if [ "$FORZAR" -eq 1 ] || [ ! -f "$destino" ]; then
    cp "$ejemplo" "$destino"
    echo "Creado $destino"
  else
    echo "Revisando $destino"
  fi

  app_key="$(valor_actual "$destino" APP_KEY)"
  if [ "$FORZAR" -eq 1 ] || [ -z "$app_key" ]; then
    app_key="$(openssl rand -base64 32 | tr -d '\n')"
    actualizar_valor "$destino" APP_KEY "$app_key"
    echo "  APP_KEY generado"
  fi

  secreto_actual="$(valor_actual "$destino" AUTH_IDENTITY_SECRET)"
  if [ "$FORZAR" -eq 1 ] || [ -z "$secreto_actual" ]; then
    actualizar_valor "$destino" AUTH_IDENTITY_SECRET "$SECRETO"
    echo "  AUTH_IDENTITY_SECRET configurado"
  fi
done

echo
echo "Listo."
echo "AUTH_IDENTITY_SECRET usado: $SECRETO"
echo "Para el clúster, usa los mismos .env por servicio en todas las laptops."
