# Deploy in produzione

A ogni push su `main`, GitHub Actions ([`.github/workflows/ci-cd.yml`](../.github/workflows/ci-cd.yml)):

1. **Test**: controllo sintassi, test end-to-end contro un finto Docker e `nginx -t` sulla configurazione HTTPS.
2. **Build**: costruisce l'immagine e la pubblica su `ghcr.io/aleeb/minecraft-server-manager` (tag `latest` e commit).
3. **Deploy**: via SSH copia `docker-compose.yml`, `nginx/` e `certbot/` sulla VPS, scarica l'immagine del commit,
   riavvia solo il manager e ricarica nginx (senza interrompere le connessioni).
   I server Minecraft sono container separati: **non vengono riavviati**.

Le pull request eseguono solo test e build, senza pubblicare né fare deploy.

## 1. Preparare la VPS (una volta sola)

Serve un Linux con Docker e il plugin compose (`docker compose version`).

```bash
# sulla VPS, come root
curl -fsSL https://get.docker.com | sh
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /opt/mc-manager /srv/minecraft/servers
chown -R deploy:deploy /opt/mc-manager /srv/minecraft
```

Crea `/opt/mc-manager/.env` partendo da [`.env.example`](.env.example) e imposta almeno `MANAGER_PASSWORD`:

```bash
sudo -u deploy nano /opt/mc-manager/.env
```

Apri nel firewall la porta del manager (8080, oppure 80/443 con HTTPS) e le porte dei server Minecraft (25565 e successive).

## 2. Chiave SSH per GitHub Actions

Sul tuo Mac:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/mc-manager-deploy -N "" -C "github-actions-deploy"
```

Copia la chiave pubblica sulla VPS in `/home/deploy/.ssh/authorized_keys`:

```bash
ssh-copy-id -i ~/.ssh/mc-manager-deploy.pub deploy@IP_DELLA_VPS
```

## 3. Secret del repository

In GitHub → Settings → Secrets and variables → Actions (o con `gh`):

| Secret             | Valore                                              |
|--------------------|-----------------------------------------------------|
| `PROD_HOST`        | IP o dominio della VPS                              |
| `PROD_USER`        | `deploy`                                            |
| `PROD_SSH_KEY`     | contenuto di `~/.ssh/mc-manager-deploy` (privata)   |
| `PROD_KNOWN_HOSTS` | output di `ssh-keyscan IP_DELLA_VPS` (consigliato)  |
| `PROD_PORT`        | porta SSH, solo se diversa da 22                    |

```bash
gh secret set PROD_HOST --body "IP_DELLA_VPS"
gh secret set PROD_USER --body "deploy"
gh secret set PROD_SSH_KEY < ~/.ssh/mc-manager-deploy
ssh-keyscan IP_DELLA_VPS | gh secret set PROD_KNOWN_HOSTS
```

Variabile opzionale `PROD_DEPLOY_DIR` (default `/opt/mc-manager`).

Il deploy usa l'environment GitHub `production`: da Settings → Environments puoi aggiungere
l'approvazione manuale prima di ogni rilascio.

## HTTPS con nginx e Let's Encrypt (consigliato)

La password del manager viaggia con Basic Auth: senza HTTPS passa in chiaro. Il profilo `https` avvia:

- **nginx** ([`nginx/`](nginx)): reverse proxy su 80/443 verso il manager. Reindirizza HTTP → HTTPS, abilita HTTP/2
  e HSTS, e non usa buffer, così log in tempo reale e avanzamento della creazione arrivano subito.
- **certbot** ([`certbot/run.sh`](certbot/run.sh)): il bot che chiede il certificato a Let's Encrypt (challenge
  HTTP-01 via webroot) e poi controlla il rinnovo **ogni 12 ore**. certbot rinnova quando mancano meno di 30 giorni;
  nginx controlla ogni minuto se il certificato è cambiato e si ricarica da solo.

Al primo avvio, finché il certificato non c'è, nginx serve solo la challenge e risponde 503 al resto. Appena
il certificato arriva (di solito entro un minuto) passa ad HTTPS senza bisogno di riavvii.

Per attivarlo:

1. punta un dominio (record A/AAAA, es. `mc.tuodominio.it`) sull'IP della VPS e apri le porte **80** e **443**;
2. in `/opt/mc-manager/.env` imposta:
   ```bash
   COMPOSE_PROFILES=https
   DOMAIN=mc.tuodominio.it
   LETSENCRYPT_EMAIL=tu@example.com   # avvisi di scadenza; implica l'accettazione dei termini di Let's Encrypt
   MANAGER_HOST=127.0.0.1             # il manager non è più esposto direttamente
   ```
3. fai un deploy (push su `main`) oppure, sulla VPS, `cd /opt/mc-manager && docker compose up -d`;
4. controlla l'esito con `docker logs mc-manager-certbot`.

Per le prime prove puoi usare `LETSENCRYPT_STAGING=1` (certificati non validi per i browser, ma senza consumare
i limiti di Let's Encrypt). Per passare ai certificati veri, rimuovi quelli di prova e riavvia il bot:

```bash
cd /opt/mc-manager
docker compose run --rm --entrypoint certbot certbot delete --cert-name mc.tuodominio.it
# imposta LETSENCRYPT_STAGING=0 in .env, poi:
docker compose up -d certbot
```

Rinnovo manuale o verifica: `docker compose exec certbot certbot renew --dry-run --webroot -w /var/www/certbot`.

## Rollback

Ogni immagine è taggata con il commit. Sulla VPS:

```bash
cd /opt/mc-manager
IMAGE_TAG=<sha-del-commit-buono> docker compose up -d
```

Se l'immagine non è più sulla VPS, prima fai `docker login ghcr.io` con un token GitHub che abbia `read:packages`.
