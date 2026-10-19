#!/bin/sh
# Avvio di nginx: genera la configurazione (solo HTTP finché manca il certificato, poi HTTPS)
# e la ricarica da solo quando certbot ottiene o rinnova il certificato.
# Argomenti: "reload" rigenera e ricarica un nginx già avviato, "check" rigenera e verifica (CI).
set -eu

: "${DOMAIN:?Imposta DOMAIN in .env}"
: "${MANAGER_PORT:=8080}"
export DOMAIN MANAGER_PORT

TEMPLATES=/etc/nginx/mc
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
CONF=/etc/nginx/conf.d/default.conf

render() {
  if [ -f "$CERT" ]; then mode=https; else mode=http; fi
  envsubst '${DOMAIN} ${MANAGER_PORT}' < "$TEMPLATES/$mode.conf.template" > "$CONF.new"
  # Senza IPv6 sull'host, "listen [::]" impedirebbe a nginx di partire.
  if [ ! -f /proc/net/if_inet6 ]; then sed -i '/listen \[::\]/d' "$CONF.new"; fi
  mv "$CONF.new" "$CONF"
  echo "[nginx] configurazione $mode per $DOMAIN"
}

reload() {
  render
  if nginx -t -q; then nginx -s reload; else echo "[nginx] configurazione non valida, reload annullato" >&2; fi
}

# Cambia quando il certificato viene creato o rinnovato (i file in live/ puntano a nuove versioni).
stamp() {
  if [ -f "$CERT" ]; then stat -c %Y "$(readlink -f "$CERT")"; else echo none; fi
}

case "${1:-}" in
  reload) reload; exit 0 ;;
  check) render; exec nginx -t ;;
esac

render
(
  last=$(stamp)
  while sleep 60; do
    now=$(stamp)
    if [ "$now" != "$last" ]; then
      last=$now
      echo "[nginx] certificato cambiato, ricarico"
      reload
    fi
  done
) &

exec nginx -g 'daemon off;'
