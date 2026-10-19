# Minecraft Server Manager

Interfaccia web per creare, configurare e gestire più server Minecraft su Docker,
basata sull'immagine [`itzg/minecraft-server`](https://docker-minecraft-server.readthedocs.io).

## Avvio

Serve Node.js 18 o superiore e Docker (OrbStack, Docker Desktop o Colima) avviato. Non ci sono dipendenze da installare.

```bash
node manager/server.js
```

Poi apri http://localhost:8080.

| Variabile     | Default                    | Significato                                  |
|---------------|----------------------------|----------------------------------------------|
| `PORT`        | `8080`                     | Porta dell'interfaccia web                   |
| `HOST`        | `127.0.0.1`                | Interfaccia di ascolto (vedi Sicurezza)      |
| `SERVERS_DIR` | `<progetto>/servers`       | Dove vengono create le cartelle dei server   |
| `DOCKER_HOST` | rilevato in automatico     | Socket Docker, es. `unix:///var/run/docker.sock` |
| `MANAGER_USER` | `admin`                   | Utente per l'accesso (Basic Auth)            |
| `MANAGER_PASSWORD` | vuota                 | Se impostata, l'interfaccia chiede la password |
| `MEMORY_RESERVE` | `1g`                    | RAM di Docker lasciata al sistema            |
| `HEAP_SHARE`  | `0.8`                      | Quota della RAM restante usabile come heap Java |
| `RAM_BUDGET`  | calcolato                  | Forza il budget heap totale (es. `6g`)       |
| `RESTART_WARNING` | `60`                   | Secondi di preavviso prima del riavvio per la RAM |

## Funzioni

- **Dashboard**: stato, indirizzo, uptime, CPU e RAM di ogni server; filtri e ricerca.
- **Azioni multiple**: seleziona più server e avviali, fermali, riavviali o eliminali insieme.
- **Tutte le impostazioni dell'immagine**, divise per categoria e con ricerca: tipo di server (Vanilla, Paper, Purpur, Fabric, Forge, NeoForge, modpack…), memoria e flag JVM, gameplay, mondo, whitelist e OP, RCON, resource pack, plugin e mod (Modrinth, CurseForge, Spigot), modpack, auto-pausa e auto-stop, opzioni avanzate, più variabili personalizzate libere.
- **Impostazioni Docker**: porta, tag immagine (versione Java), cartella dati, restart policy, limiti di RAM e CPU, porte extra (Geyser, BlueMap, ecc.).
- **Preset** e **copia impostazioni** da un server esistente; **duplica** un server.
- **Modifica**: il container viene ricreato con la nuova configurazione; il mondo in `/data` resta invariato.
- **Bilanciamento RAM**: contano solo i server accesi. Se la somma delle heap richieste supera il budget
  (`(RAM Docker − MEMORY_RESERVE) × HEAP_SHARE`, meno la RAM dei container esterni), tutte vengono ridotte
  in proporzione. Il server che parte riceve subito la sua quota. Quelli già accesi che devono scendere
  ricevono un conto alla rovescia in chat e vengono riavviati con la nuova heap. Quando un server si ferma,
  gli altri riprendono la RAM richiesta al loro prossimo avvio o riavvio.
- **Console**: log in tempo reale, comandi via RCON con cronologia, comandi rapidi e lista dei giocatori online.
- **Anteprima docker-compose** della configurazione.

I container già esistenti con l'immagine itzg (es. quello di `docker-compose.yml`) compaiono come
"esterni": puoi avviarli, fermarli, aprirne la console e duplicarli, ma non modificarli.

## Sicurezza

Chi raggiunge l'interfaccia controlla Docker sulla macchina. Di default ascolta solo su `127.0.0.1`;
per ascoltare su un altro indirizzo (es. `HOST=0.0.0.0`) il manager **richiede** `MANAGER_PASSWORD`,
altrimenti non parte. In produzione usalo dietro HTTPS (vedi [deploy/README.md](../deploy/README.md)).

## Test

```bash
cd manager && npm test
```

I test avviano il manager contro un finto Docker ([test/fake-docker.js](test/fake-docker.js)), quindi non serve Docker.

## Produzione

Immagine Docker, compose di produzione e pipeline CI/CD: vedi [deploy/README.md](../deploy/README.md).
