#!/bin/sh
# Bot Let's Encrypt: ottiene il certificato al primo avvio e poi controlla il rinnovo ogni 12 ore.
# certbot rinnova solo quando mancano meno di 30 giorni alla scadenza; nginx si accorge del
# nuovo certificato e si ricarica da solo.
set -eu

: "${DOMAIN:?Imposta DOMAIN in .env}"
: "${LETSENCRYPT_EMAIL:?Imposta LETSENCRYPT_EMAIL in .env}"
WEBROOT=/var/www/certbot
STAGING=""
if [ "${LETSENCRYPT_STAGING:-0}" = 1 ]; then STAGING="--staging"; fi

log() { echo "[certbot] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Aspetta che nginx risponda sulla porta 80 per servire la challenge.
until python3 -c "import socket; socket.create_connection(('127.0.0.1', 80), 2)" 2>/dev/null; do
  log "in attesa di nginx sulla porta 80…"
  sleep 5
done

while :; do
  if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    log "richiedo il certificato per $DOMAIN"
    if certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
        --email "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email \
        --non-interactive --keep-until-expiring $STAGING; then
      log "certificato ottenuto"
    else
      log "richiesta fallita (DNS che punta qui? porta 80 aperta?), riprovo tra un'ora"
      sleep 3600
      continue
    fi
  else
    certbot renew --webroot -w "$WEBROOT" --non-interactive --quiet $STAGING || log "rinnovo fallito, riprovo al prossimo giro"
  fi
  sleep 43200
done
