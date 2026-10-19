#!/bin/sh
# Aggiorna il manager in produzione con l'ultima versione di main.
#
#   ./update.sh           scarica da GHCR l'immagine già testata dalla CI (serve "docker login ghcr.io")
#   ./update.sh --build   costruisce l'immagine sul server dal codice (non serve il login a GHCR)
#
# I server Minecraft sono container separati: non vengono riavviati.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Manca deploy/.env: copia .env.example in .env e imposta almeno MANAGER_PASSWORD." >&2
  exit 1
fi

echo "==> Aggiorno il repository"
git pull --ff-only

if [ "${1:-}" = "--build" ]; then
  echo "==> Costruisco l'immagine sul server"
  docker compose build manager
  docker compose pull --ignore-buildable
else
  echo "==> Scarico le immagini"
  docker compose pull
fi

echo "==> Avvio i servizi"
docker compose up -d --remove-orphans

if docker compose config --services | grep -qx nginx; then
  echo "==> Ricarico nginx"
  docker compose exec -T nginx sh /etc/nginx/mc/start.sh reload
fi

docker image prune -f >/dev/null
docker compose ps
