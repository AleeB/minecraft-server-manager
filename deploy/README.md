# Produzione

La pipeline GitHub Actions ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) gira a ogni push e pull request:

1. **Test**: controllo sintassi e test end-to-end del manager contro un finto Docker.
2. **nginx**: `nginx -t` sulla configurazione, con e senza certificato.
3. **Build**: costruisce l'immagine e, solo su `main`, la pubblica su `ghcr.io/aleeb/minecraft-server-manager`
   con i tag `latest` e quello del commit.

La pipeline **non** tocca il server. La produzione si aggiorna a mano con [`update.sh`](update.sh), che usa
`docker compose` da una copia del repository sul server. Così non serve aprire SSH su internet.

## 1. Preparare il server (una volta sola)

Serve Linux con Docker e il plugin compose (`docker compose version`). Come utente amministratore:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
sudo mkdir -p /opt/mc-manager /srv/minecraft/servers
sudo chown -R deploy:deploy /opt/mc-manager /srv/minecraft
```

Da qui in poi lavora come `deploy`:

```bash
sudo -iu deploy
```

### Accesso al repository privato

Il server deve poter leggere il repository. Il modo più semplice è una **deploy key**: una chiave SSH di sola
lettura valida solo per questo repository.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github-mc-manager -N "" -C "mc-manager server"
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github-mc-manager
  IdentitiesOnly yes
EOF
cat ~/.ssh/github-mc-manager.pub
```

Aggiungi la chiave pubblica su GitHub in **Settings → Deploy keys → Add deploy key** (lascia "Allow write access"
disattivato), oppure dal Mac con
`gh repo deploy-key add chiave.pub --repo AleeB/minecraft-server-manager --title "server"`.

Poi clona il repository:

```bash
git clone git@github.com:AleeB/minecraft-server-manager.git /opt/mc-manager
```

Se `/opt/mc-manager` contiene già file (per esempio un vecchio `.env`), spostali prima altrove: `git clone` vuole
una cartella vuota.

### Accesso all'immagine su GHCR (facoltativo)

Il pacchetto è privato come il repository. Per scaricare l'immagine testata dalla CI crea su GitHub un token
**classic** con il solo permesso `read:packages` (Settings → Developer settings → Personal access tokens) e:

```bash
docker login ghcr.io -u AleeB
```

Come password incolla il token. Se preferisci non creare token, salta questo passo e aggiorna con
`./update.sh --build`, che costruisce l'immagine direttamente sul server.

### Configurazione

```bash
cd /opt/mc-manager/deploy
cp .env.example .env
nano .env
chmod 600 .env
```

Imposta almeno `MANAGER_PASSWORD`. `.env` è escluso da git: i `git pull` non lo toccano mai.

## 2. Primo avvio e aggiornamenti

Il comando è lo stesso per entrambi:

```bash
cd /opt/mc-manager/deploy && ./update.sh
```

Oppure, senza GHCR:

```bash
cd /opt/mc-manager/deploy && ./update.sh --build
```

Lo script:

1. fa `git pull` di `main`, quindi arrivano anche le modifiche a compose, nginx e certbot;
2. scarica l'immagine (o la costruisce con `--build`);
3. riavvia solo i servizi cambiati con `docker compose up -d`;
4. ricarica nginx senza interrompere le connessioni.

I server Minecraft sono container separati e **non vengono riavviati**.

Conviene aggiornare dopo che la pipeline del commit è verde: con l'immagine da GHCR, `latest` è sempre l'ultima
build che ha passato i test.

Comandi utili, sempre in `/opt/mc-manager/deploy`:

| Comando | A cosa serve |
|---|---|
| `docker compose ps` | Stato dei servizi |
| `docker compose logs -f manager` | Log del manager |
| `docker compose logs -f certbot` | Esito di emissione e rinnovo del certificato |
| `docker compose restart manager` | Riavvio del solo manager |
| `docker compose down` | Ferma manager, nginx e certbot (i server Minecraft restano accesi) |

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

1. punta un dominio (es. `tuonome.duckdns.org`) sull'IP pubblico del server;
2. apri le porte **80** e **443** TCP verso il server (port forwarding sul router se è a casa);
3. in `deploy/.env` imposta:
   ```bash
   COMPOSE_PROFILES=https
   DOMAIN=tuonome.duckdns.org
   LETSENCRYPT_EMAIL=tu@example.com   # avvisi di scadenza; implica l'accettazione dei termini di Let's Encrypt
   MANAGER_HOST=127.0.0.1             # il manager non è più esposto direttamente
   ```
4. lancia `./update.sh` e controlla l'esito con `docker compose logs -f certbot`.

Per le prime prove puoi usare `LETSENCRYPT_STAGING=1` (certificati non validi per i browser, ma senza consumare
i limiti di Let's Encrypt). Per passare ai certificati veri, rimuovi quelli di prova e riavvia il bot:

```bash
cd /opt/mc-manager/deploy
docker compose run --rm --entrypoint certbot certbot delete --cert-name tuonome.duckdns.org
# imposta LETSENCRYPT_STAGING=0 in .env, poi:
docker compose up -d certbot
```

Verifica del rinnovo: `docker compose exec certbot certbot renew --dry-run --webroot -w /var/www/certbot`.

nginx accetta caricamenti fino a `WORLD_UPLOAD_MAX` (default `2g`), lo stesso limite del manager per l'importazione
dei mondi, e li inoltra al manager in streaming. Se cambi il valore in `.env`, rilancia `./update.sh`.

## Tornare a una versione precedente

Ogni immagine su GHCR è taggata con il commit. In `/opt/mc-manager/deploy`:

```bash
IMAGE_TAG=<sha-del-commit-buono> docker compose up -d manager
```

Con `--build`, invece, riporta il codice indietro (`git checkout <sha>`) e rilancia `docker compose up -d --build manager`.
Per tornare all'ultima versione: `git checkout main` e `./update.sh`.
