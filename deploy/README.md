# Deploy in produzione

A ogni push su `main`, GitHub Actions ([`.github/workflows/ci-cd.yml`](../.github/workflows/ci-cd.yml)):

1. **Test**: controllo sintassi e test end-to-end contro un finto Docker.
2. **Build**: costruisce l'immagine e la pubblica su `ghcr.io/aleeb/minecraft-server-manager` (tag `latest` e commit).
3. **Deploy**: via SSH copia `docker-compose.yml` e `Caddyfile` sulla VPS, scarica l'immagine del commit e riavvia solo il manager.
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

## HTTPS (consigliato)

La password del manager viaggia con Basic Auth: senza HTTPS passa in chiaro. Per avere HTTPS automatico:

1. punta un dominio (es. `mc.tuodominio.it`) sull'IP della VPS e apri le porte 80 e 443;
2. in `.env` imposta `COMPOSE_PROFILES=https`, `DOMAIN=mc.tuodominio.it` e `MANAGER_HOST=127.0.0.1`;
3. al deploy successivo (o con `docker compose up -d` in `/opt/mc-manager`) Caddy ottiene il certificato.

## Rollback

Ogni immagine è taggata con il commit. Sulla VPS:

```bash
cd /opt/mc-manager
IMAGE_TAG=<sha-del-commit-buono> docker compose up -d
```

Se l'immagine non è più sulla VPS, prima fai `docker login ghcr.io` con un token GitHub che abbia `read:packages`.
