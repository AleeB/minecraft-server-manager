'use strict';
// Minecraft Server Manager — backend senza dipendenze che parla con il Docker Engine API
// tramite il socket unix e serve il frontend statico in ./public.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const SERVERS_DIR = path.resolve(process.env.SERVERS_DIR || path.join(ROOT, 'servers'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUTH_USER = process.env.MANAGER_USER || 'admin';
const AUTH_PASSWORD = process.env.MANAGER_PASSWORD || '';
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const IMAGE = 'itzg/minecraft-server';
const LABEL_MANAGED = 'mcm.managed';
const LABEL_CONFIG = 'mcm.config';
const LABEL_HEAP = 'mcm.heap';
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

// Bilanciamento RAM: la memoria heap dei server accesi non può superare il budget.
// Budget = (RAM di Docker − riserva per il sistema) × quota heap (il resto è overhead della JVM).
const MEMORY_RESERVE = process.env.MEMORY_RESERVE || '1g';
const HEAP_SHARE = Number(process.env.HEAP_SHARE) || 0.8;
const RAM_BUDGET = process.env.RAM_BUDGET || '';
const RESTART_WARNING_S = Math.max(5, Number(process.env.RESTART_WARNING) || 60);
const MIN_HEAP_MB = 512;

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

function findSocket() {
  const dh = process.env.DOCKER_HOST;
  if (dh && dh.startsWith('unix://')) return dh.slice('unix://'.length);
  const candidates = [
    '/var/run/docker.sock',
    path.join(os.homedir(), '.orbstack/run/docker.sock'),
    path.join(os.homedir(), '.docker/run/docker.sock'),
    path.join(os.homedir(), '.colima/default/docker.sock'),
    path.join(os.homedir(), '.rd/docker.sock'),
  ];
  // statSync segue i symlink: un link "appeso" (daemon spento) viene scartato.
  return candidates.find((p) => { try { fs.statSync(p); return true; } catch { return false; } }) || candidates[0];
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function docker(method, p, body, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ socketPath: findSocket(), path: p, method, headers }, (res) => {
      if (raw && res.statusCode < 400) return resolve(res);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        if (res.statusCode >= 400) {
          return reject(httpError(res.statusCode, (json && json.message) || text || `Docker HTTP ${res.statusCode}`));
        }
        resolve(json);
      });
    });
    req.on('error', (e) => reject(httpError(503, `Docker non raggiungibile (${e.code || e.message}). OrbStack/Docker è avviato?`)));
    if (data) req.write(data);
    req.end();
  });
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Con Tty=false Docker multiplexa stdout/stderr con un header di 8 byte per frame.
function createDemuxer(onData) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      onData(buf.subarray(8, 8 + size));
      buf = buf.subarray(8 + size);
    }
  };
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

async function imageExists(ref) {
  try { await docker('GET', `/images/${encodeURIComponent(ref)}/json`); return true; } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

async function pullImage(tag, emit) {
  const res = await docker('POST', `/images/create?fromImage=${encodeURIComponent(IMAGE)}&tag=${encodeURIComponent(tag)}`, undefined, { raw: true });
  const layers = new Map();
  let buf = '';
  let lastEmit = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.error) return reject(httpError(500, ev.error));
        if (ev.id && ev.status) layers.set(ev.id, ev.status);
        const now = Date.now();
        if (now - lastEmit > 700) {
          lastEmit = now;
          const total = layers.size;
          const done = [...layers.values()].filter((s) => /complete|exists/i.test(s)).length;
          emit({ type: 'progress', msg: `Download immagine ${IMAGE}:${tag} — layer ${done}/${total}` });
        }
      }
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
}

async function ensureImage(tag, emit) {
  const ref = `${IMAGE}:${tag}`;
  if (await imageExists(ref)) return;
  emit({ type: 'progress', msg: `Immagine ${ref} non presente, avvio download (può richiedere qualche minuto)…` });
  await pullImage(tag, emit);
  emit({ type: 'progress', msg: `Immagine ${ref} pronta` });
}

// ---------------------------------------------------------------------------
// Configurazione → specifica del container
// ---------------------------------------------------------------------------

function parseSize(v) {
  if (v === undefined || v === null || v === '') return 0;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i);
  if (!m) throw httpError(400, `Dimensione non valida: "${v}" (es. 4g, 512m)`);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

// "4G", "512m", "2048" (MB) → megabyte
function toMB(v, dflt = 1024) {
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  const t = String(v).trim();
  if (/^\d+$/.test(t)) return Number(t);
  try { return Math.round(parseSize(t) / 1024 ** 2) || dflt; } catch { return dflt; }
}

const fmtMB = (mb) => (mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024}G` : mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb}M`);

const requestedMB = (cfg) => toMB(cfg.env.MAX_MEMORY || cfg.env.MEMORY);

function isTrue(v) { return String(v).toUpperCase() === 'TRUE'; }

function validPort(p, what) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw httpError(400, `${what}: porta non valida (${p})`);
  return n;
}

function normalizeConfig(input) {
  const cfg = JSON.parse(JSON.stringify(input || {}));
  if (!cfg.name || !NAME_RE.test(cfg.name)) {
    throw httpError(400, `Nome non valido: "${cfg.name || ''}". Usa lettere, numeri, "-", "_" o "." (max 63).`);
  }
  cfg.imageTag = (cfg.imageTag || 'latest').trim();
  if (!/^[\w][\w.-]{0,127}$/.test(cfg.imageTag)) throw httpError(400, `Tag immagine non valido: ${cfg.imageTag}`);
  cfg.port = validPort(cfg.port || 25565, 'Porta del server');
  cfg.dataPath = (cfg.dataPath || '').trim() || path.join(SERVERS_DIR, cfg.name);
  if (!path.isAbsolute(cfg.dataPath)) cfg.dataPath = path.resolve(ROOT, cfg.dataPath);
  cfg.restart = ['no', 'always', 'unless-stopped', 'on-failure'].includes(cfg.restart) ? cfg.restart : 'unless-stopped';
  cfg.env = cfg.env || {};
  cfg.customEnv = Array.isArray(cfg.customEnv) ? cfg.customEnv.filter((e) => e && e.key) : [];
  cfg.extraPorts = Array.isArray(cfg.extraPorts) ? cfg.extraPorts.filter((p) => p && p.host && p.container) : [];
  cfg.autoStart = cfg.autoStart !== false;
  for (const e of cfg.customEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key)) throw httpError(400, `Nome variabile non valido: ${e.key}`);
  }
  return cfg;
}

function buildEnv(cfg, heapMB) {
  const env = { ...cfg.env };
  for (const { key, value } of cfg.customEnv) env[key] = value;
  env.EULA = 'TRUE';
  if (heapMB) {
    env.MEMORY = `${heapMB}M`;
    if (env.MAX_MEMORY) env.MAX_MEMORY = `${heapMB}M`;
    if (env.INIT_MEMORY && toMB(env.INIT_MEMORY) > heapMB) env.INIT_MEMORY = `${heapMB}M`;
  }
  return Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${k}=${v}`);
}

function buildContainerSpec(cfg, heapMB = requestedMB(cfg)) {
  const env = { ...cfg.env };
  for (const { key, value } of cfg.customEnv) env[key] = value;

  const exposed = {};
  const bindings = {};
  const bind = (containerPort, hostPort) => {
    exposed[containerPort] = {};
    (bindings[containerPort] = bindings[containerPort] || []).push({ HostPort: String(hostPort) });
  };

  bind('25565/tcp', cfg.port);
  if (isTrue(env.ENABLE_QUERY)) bind(`${env.QUERY_PORT || 25565}/udp`, cfg.port);
  if (cfg.exposeRcon && cfg.rconHostPort) {
    bind(`${env.RCON_PORT || 25575}/tcp`, validPort(cfg.rconHostPort, 'Porta RCON'));
  }
  for (const p of cfg.extraPorts) {
    const proto = p.proto === 'udp' ? 'udp' : 'tcp';
    bind(`${validPort(p.container, 'Porta extra (container)')}/${proto}`, validPort(p.host, 'Porta extra (host)'));
  }

  const hostConfig = {
    Binds: [`${cfg.dataPath}:/data`],
    PortBindings: bindings,
    RestartPolicy: { Name: cfg.restart },
  };
  const mem = parseSize(cfg.memoryLimit);
  if (mem) hostConfig.Memory = mem;
  const cpus = Number(cfg.cpus);
  if (cpus > 0) hostConfig.NanoCpus = Math.round(cpus * 1e9);
  // L'autopausa usa knockd, che richiede NET_RAW.
  if (isTrue(env.ENABLE_AUTOPAUSE)) hostConfig.CapAdd = ['NET_RAW'];

  return {
    Image: `${IMAGE}:${cfg.imageTag}`,
    Env: buildEnv(cfg, heapMB),
    Tty: true,
    OpenStdin: true,
    ExposedPorts: exposed,
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_CONFIG]: Buffer.from(JSON.stringify(cfg)).toString('base64'),
      [LABEL_HEAP]: String(heapMB),
    },
    HostConfig: hostConfig,
  };
}

function decodeConfig(labels) {
  try { return JSON.parse(Buffer.from(labels[LABEL_CONFIG], 'base64').toString('utf8')); } catch { return null; }
}

function envToMap(list) {
  const out = {};
  for (const item of list || []) {
    const i = item.indexOf('=');
    if (i > 0) out[item.slice(0, i)] = item.slice(i + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lettura stato dei server
// ---------------------------------------------------------------------------

function isMinecraftContainer(c) {
  return (c.Labels && c.Labels[LABEL_MANAGED] === 'true') || (c.Image || '').startsWith(IMAGE);
}

const imageEnvCache = new Map();
async function imageEnv(imageId) {
  if (!imageEnvCache.has(imageId)) {
    try { imageEnvCache.set(imageId, envToMap((await docker('GET', `/images/${imageId}/json`)).Config.Env)); } catch { return {}; }
  }
  return imageEnvCache.get(imageId);
}

async function summarize(id) {
  const info = await docker('GET', `/containers/${encodeURIComponent(id)}/json`);
  const labels = info.Config.Labels || {};
  const managed = labels[LABEL_MANAGED] === 'true';
  const env = envToMap(info.Config.Env);
  const ports = [];
  for (const [cport, binds] of Object.entries(info.HostConfig.PortBindings || {})) {
    for (const b of binds || []) ports.push({ container: cport, host: Number(b.HostPort) });
  }
  const gamePort = ports.find((p) => p.container === '25565/tcp');
  const dataMount = (info.Mounts || []).find((m) => m.Destination === '/data');
  const config = managed ? decodeConfig(labels) : null;
  const defaults = await imageEnv(info.Image);
  const userEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => defaults[k] !== v));
  const heapMB = Number(labels[LABEL_HEAP]) || toMB(env.MAX_MEMORY || env.MEMORY);
  const name = info.Name.replace(/^\//, '');
  const pending = pendingRestarts.get(name);
  return {
    id: info.Id,
    name,
    managed,
    compose: labels['com.docker.compose.project'] || null,
    state: info.State.Status,
    health: info.State.Health ? info.State.Health.Status : null,
    startedAt: info.State.StartedAt,
    finishedAt: info.State.FinishedAt,
    exitCode: info.State.ExitCode,
    restartCount: info.RestartCount,
    image: info.Config.Image,
    ports,
    port: gamePort ? gamePort.host : null,
    dataPath: dataMount ? dataMount.Source : null,
    type: env.TYPE || 'VANILLA',
    version: env.VERSION || 'LATEST',
    motd: env.MOTD || '',
    memory: fmtMB(heapMB),
    heapMB,
    requestedMB: config ? requestedMB(config) : heapMB,
    pendingRestart: pending ? { at: pending.at, heapMB: pending.heapMB } : null,
    maxPlayers: env.MAX_PLAYERS || '',
    rconEnabled: env.ENABLE_RCON !== 'false' && env.ENABLE_RCON !== 'FALSE',
    env,
    userEnv,
    config,
  };
}

async function listServers() {
  const all = await docker('GET', '/containers/json?all=1');
  const mc = all.filter(isMinecraftContainer);
  const out = await Promise.all(mc.map((c) => summarize(c.Id).catch(() => null)));
  return out.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

async function usedHostPorts() {
  const all = await docker('GET', '/containers/json?all=1');
  const used = new Set();
  await Promise.all(all.map(async (c) => {
    try {
      const info = await docker('GET', `/containers/${c.Id}/json`);
      for (const binds of Object.values(info.HostConfig.PortBindings || {})) {
        for (const b of binds || []) if (b.HostPort) used.add(Number(b.HostPort));
      }
    } catch { /* container sparito nel frattempo */ }
  }));
  return used;
}

function portFreeOnHost(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

async function suggestPorts(count, start, exclude = []) {
  const used = await usedHostPorts();
  for (const p of exclude) used.add(Number(p));
  const out = [];
  for (let p = start; p <= 65535 && out.length < count; p++) {
    if (used.has(p)) continue;
    if (await portFreeOnHost(p)) out.push(p);
  }
  return { ports: out, used: [...used].sort((a, b) => a - b) };
}

async function containerStats(id) {
  const s = await docker('GET', `/containers/${encodeURIComponent(id)}/stats?stream=false`);
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage || 0);
  const sysDelta = (s.cpu_stats.system_cpu_usage || 0) - (s.precpu_stats.system_cpu_usage || 0);
  const cpus = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const cpu = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
  const ms = s.memory_stats || {};
  const cache = ms.stats ? (ms.stats.inactive_file ?? ms.stats.total_inactive_file ?? ms.stats.cache ?? 0) : 0;
  return { cpu, memUsage: Math.max(0, (ms.usage || 0) - cache), memLimit: ms.limit || 0 };
}

async function execInContainer(id, cmd) {
  const ex = await docker('POST', `/containers/${encodeURIComponent(id)}/exec`, {
    AttachStdout: true, AttachStderr: true, Tty: true, Cmd: cmd,
  });
  const stream = await docker('POST', `/exec/${ex.Id}/start`, { Detach: false, Tty: true }, { raw: true });
  const out = stripAnsi((await readAll(stream)).toString('utf8')).trim();
  const result = await docker('GET', `/exec/${ex.Id}/json`);
  return { output: out, exitCode: result.ExitCode };
}

// ---------------------------------------------------------------------------
// Operazioni
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bilanciamento della RAM tra i server accesi
// ---------------------------------------------------------------------------

// Le operazioni che cambiano la RAM in uso sono eseguite una alla volta.
let opChain = Promise.resolve();
function exclusive(fn) {
  const run = opChain.then(() => fn());
  opChain = run.catch(() => {});
  return run;
}

const isActive = (s) => ['running', 'restarting', 'paused'].includes(s.state);
const pendingRestarts = new Map(); // nome → { at, heapMB, timers }

async function memoryBudgetMB() {
  if (RAM_BUDGET) return toMB(RAM_BUDGET);
  const info = await docker('GET', '/info');
  return Math.max(MIN_HEAP_MB, Math.floor((info.MemTotal / 1024 ** 2 - toMB(MEMORY_RESERVE)) * HEAP_SHARE));
}

// Calcola la heap di ogni server acceso (più quello che sta per partire, `incoming`).
// Se la somma delle heap richieste supera il budget, tutte vengono ridotte in proporzione.
// I container esterni non si possono ridimensionare: la loro heap viene sottratta dal budget.
async function planMemory(incoming = null, exclude = []) {
  const budget = await memoryBudgetMB();
  const skip = new Set(exclude);
  if (incoming) skip.add(incoming.name);
  const servers = (await listServers()).filter((s) => isActive(s) && !skip.has(s.name));
  let fixed = 0;
  const flex = [];
  for (const s of servers) {
    if (s.managed && s.config) flex.push({ name: s.name, server: s, req: requestedMB(s.config), cur: s.heapMB });
    else fixed += s.heapMB;
  }
  if (incoming) flex.push({ name: incoming.name, req: requestedMB(incoming.cfg), cur: null, incoming: true });
  const available = Math.max(0, budget - fixed);
  const requested = flex.reduce((a, f) => a + f.req, 0);
  const factor = requested > available ? available / requested : 1;
  for (const f of flex) f.heapMB = factor < 1 ? Math.max(MIN_HEAP_MB, Math.floor((f.req * factor) / 64) * 64) : f.req;
  return { budget, fixed, available, requested, factor, flex, me: flex.find((f) => f.incoming) };
}

// I server accesi che devono scendere di RAM vengono avvisati in chat e riavviati dopo il conto alla rovescia.
// Chi potrebbe salire non viene toccato: riceve la RAM in più al prossimo avvio/riavvio.
function applyPlan(plan, emit) {
  if (plan.factor < 1) {
    emit({ type: 'progress', msg: `RAM insufficiente: richiesti ${fmtMB(plan.requested)}, disponibili ${fmtMB(plan.available)}. Ridimensiono al ${Math.round(plan.factor * 100)}%.` });
  }
  for (const f of plan.flex) {
    if (f.incoming) continue;
    const pending = pendingRestarts.get(f.name);
    if (f.heapMB < f.cur) {
      if (pending) pending.heapMB = Math.min(pending.heapMB, f.heapMB);
      else scheduleResizeRestart(f.server, f.heapMB);
      emit({ type: 'progress', msg: `${f.name}: heap ${fmtMB(f.cur)} → ${fmtMB(f.heapMB)}, riavvio tra ${RESTART_WARNING_S}s (giocatori avvisati in chat)` });
    }
  }
}

function scheduleResizeRestart(s, heapMB) {
  const entry = { at: Date.now() + RESTART_WARNING_S * 1000, heapMB, timers: [] };
  pendingRestarts.set(s.name, entry);
  const say = (sec) => execInContainer(s.id, ['rcon-cli', `say Riavvio tra ${sec} ${sec === 1 ? 'secondo' : 'secondi'} per adeguare la RAM del server (${fmtMB(entry.heapMB)}).`]).catch(() => {});
  const marks = [...new Set([RESTART_WARNING_S, 60, 30, 10, 5, 3, 2, 1])].filter((x) => x <= RESTART_WARNING_S);
  for (const sec of marks) entry.timers.push(setTimeout(() => say(sec), (RESTART_WARNING_S - sec) * 1000));
  entry.timers.push(setTimeout(() => {
    exclusive(async () => {
      pendingRestarts.delete(s.name);
      const cur = await summarize(s.name).catch(() => null);
      // Se nel frattempo è stato fermato, la RAM verrà ricalcolata al prossimo avvio.
      if (!cur || !cur.config || !isActive(cur)) return;
      await recreateContainer(cur, cur.config, { heapMB: entry.heapMB, start: true, emit: () => {} });
      console.log(`[ram] ${cur.name} riavviato con heap ${fmtMB(entry.heapMB)}`);
    }).catch((e) => console.error(`[ram] riavvio di ${s.name} fallito: ${e.message}`));
  }, RESTART_WARNING_S * 1000));
}

function cancelPendingRestart(name) {
  const p = pendingRestarts.get(name);
  if (!p) return;
  p.timers.forEach(clearTimeout);
  pendingRestarts.delete(name);
}

// Ricrea un container gestito con una nuova configurazione/heap. Il vecchio viene rinominato
// prima, così se la creazione fallisce si ripristina.
async function recreateContainer(old, cfg, { heapMB, start, emit }) {
  cancelPendingRestart(old.name);
  await ensureImage(cfg.imageTag, emit);
  const tmpName = `${old.name}-old-${Date.now()}`;
  await docker('POST', `/containers/${old.id}/rename?name=${encodeURIComponent(tmpName)}`);
  let newId;
  try {
    fs.mkdirSync(cfg.dataPath, { recursive: true });
    newId = (await docker('POST', `/containers/create?name=${encodeURIComponent(cfg.name)}`, buildContainerSpec(cfg, heapMB))).Id;
  } catch (e) {
    await docker('POST', `/containers/${old.id}/rename?name=${encodeURIComponent(old.name)}`).catch(() => {});
    throw e;
  }
  if (isActive(old)) emit({ type: 'progress', msg: `Arresto ${old.name} (salvataggio del mondo)…` });
  await stopContainer(old.id);
  await docker('DELETE', `/containers/${old.id}?force=1`);
  if (start) {
    emit({ type: 'progress', msg: `Avvio ${cfg.name} con heap ${fmtMB(heapMB)}…` });
    await docker('POST', `/containers/${newId}/start`);
  }
  return newId;
}

async function createServer(cfg, emit) {
  fs.mkdirSync(cfg.dataPath, { recursive: true });
  let plan = null;
  let heapMB = requestedMB(cfg);
  if (cfg.autoStart) {
    plan = await planMemory({ name: cfg.name, cfg });
    heapMB = plan.me.heapMB;
  }
  emit({ type: 'progress', msg: `Creo il container "${cfg.name}" (porta ${cfg.port}, heap ${fmtMB(heapMB)}${heapMB < requestedMB(cfg) ? ` invece di ${fmtMB(requestedMB(cfg))}` : ''})…` });
  const created = await docker('POST', `/containers/create?name=${encodeURIComponent(cfg.name)}`, buildContainerSpec(cfg, heapMB));
  if (cfg.autoStart) {
    applyPlan(plan, emit);
    emit({ type: 'progress', msg: `Avvio "${cfg.name}"…` });
    await docker('POST', `/containers/${created.Id}/start`);
  }
  return created.Id;
}

// Avvio/riavvio di un server gestito: ricalcola la sua heap e, se cambia, ricrea il container.
async function startManaged(id, restart, emit = () => {}) {
  const s = await summarize(id);
  if (!s.managed || !s.config) {
    if (restart) return docker('POST', `/containers/${s.id}/restart?t=60`);
    return docker('POST', `/containers/${s.id}/start`).catch((e) => { if (e.status !== 304) throw e; });
  }
  const plan = await planMemory({ name: s.name, cfg: s.config });
  const heapMB = plan.me.heapMB;
  if (heapMB !== s.heapMB) {
    await recreateContainer(s, s.config, { heapMB, start: true, emit });
  } else {
    cancelPendingRestart(s.name);
    if (restart && isActive(s)) await docker('POST', `/containers/${s.id}/restart?t=60`);
    else await docker('POST', `/containers/${s.id}/start`).catch((e) => { if (e.status !== 304) throw e; });
  }
  applyPlan(plan, emit);
  return { heapMB, requestedMB: requestedMB(s.config) };
}

async function stopContainer(id, timeout = 60) {
  try { await docker('POST', `/containers/${encodeURIComponent(id)}/stop?t=${timeout}`); } catch (e) {
    if (e.status !== 304) throw e; // 304 = già fermo
  }
}

function insideServersDir(p) {
  const rel = path.relative(SERVERS_DIR, path.resolve(p));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function deleteServer(id, removeData) {
  const s = await summarize(id);
  cancelPendingRestart(s.name);
  await stopContainer(id);
  await docker('DELETE', `/containers/${encodeURIComponent(id)}?force=1`);
  let dataRemoved = false;
  if (removeData && s.managed && s.dataPath) {
    if (!insideServersDir(s.dataPath)) {
      throw httpError(400, `Container rimosso, ma i dati in ${s.dataPath} non sono stati cancellati: si cancellano solo cartelle dentro ${SERVERS_DIR}.`);
    }
    fs.rmSync(s.dataPath, { recursive: true, force: true });
    dataRemoved = true;
  }
  return { name: s.name, dataRemoved };
}

const ACTIONS = {
  start: (id) => exclusive(() => startManaged(id, false)),
  stop: async (id) => { const s = await summarize(id); cancelPendingRestart(s.name); await stopContainer(id); },
  restart: (id) => exclusive(() => startManaged(id, true)),
  kill: (id) => docker('POST', `/containers/${encodeURIComponent(id)}/kill`),
  pause: (id) => docker('POST', `/containers/${encodeURIComponent(id)}/pause`),
  unpause: (id) => docker('POST', `/containers/${encodeURIComponent(id)}/unpause`),
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(httpError(413, 'Richiesta troppo grande')); req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(httpError(400, 'JSON non valido')); }
    });
    req.on('error', reject);
  });
}

// Le operazioni lunghe (pull immagine, creazione, ricreazione) rispondono in NDJSON
// così il frontend mostra l'avanzamento in tempo reale.
function ndjson(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  return (obj) => res.write(JSON.stringify(obj) + '\n');
}

async function handleCreate(req, res) {
  const body = await readBody(req);
  const list = (Array.isArray(body.servers) ? body.servers : [body]).map(normalizeConfig);
  const names = new Set();
  const ports = new Set();
  for (const c of list) {
    if (names.has(c.name)) throw httpError(400, `Nome duplicato nella richiesta: ${c.name}`);
    if (ports.has(c.port)) throw httpError(400, `Porta duplicata nella richiesta: ${c.port}`);
    names.add(c.name); ports.add(c.port);
  }
  const used = await usedHostPorts();
  for (const c of list) if (used.has(c.port)) throw httpError(409, `La porta ${c.port} è già usata da un altro container`);

  const emit = ndjson(res);
  const results = [];
  try {
    for (const tag of new Set(list.map((c) => c.imageTag))) await ensureImage(tag, emit);
    for (const cfg of list) {
      try {
        const id = await exclusive(() => createServer(cfg, emit));
        results.push({ name: cfg.name, id, ok: true });
        emit({ type: 'progress', msg: `✔ ${cfg.name} creato${cfg.autoStart ? ' e avviato' : ''}` });
      } catch (e) {
        results.push({ name: cfg.name, ok: false, error: e.message });
        emit({ type: 'progress', level: 'error', msg: `✖ ${cfg.name}: ${e.message}` });
      }
    }
    emit({ type: 'done', results });
  } catch (e) {
    emit({ type: 'error', error: e.message });
  }
  res.end();
}

async function handleUpdate(req, res, id) {
  const body = await readBody(req);
  const old = await summarize(id);
  if (!old.managed) throw httpError(400, 'Questo container non è gestito dal manager: usa "Duplica" per crearne una copia gestita.');
  const cfg = normalizeConfig(body);
  const used = await usedHostPorts();
  for (const p of old.ports) used.delete(p.host);
  if (used.has(cfg.port)) throw httpError(409, `La porta ${cfg.port} è già usata da un altro container`);

  const emit = ndjson(res);
  const start = isActive(old) || cfg.autoStart;
  try {
    const newId = await exclusive(async () => {
      const plan = start ? await planMemory({ name: cfg.name, cfg }, [old.name]) : null;
      const heapMB = plan ? plan.me.heapMB : requestedMB(cfg);
      emit({ type: 'progress', msg: `Creo il nuovo container con la configurazione aggiornata (heap ${fmtMB(heapMB)})…` });
      const nid = await recreateContainer(old, cfg, { heapMB, start, emit });
      if (plan) applyPlan(plan, emit);
      return nid;
    });
    emit({ type: 'done', results: [{ name: cfg.name, id: newId, ok: true }] });
  } catch (e) {
    emit({ type: 'error', error: e.message });
  }
  res.end();
}

async function handleLogs(req, res, id, query) {
  const info = await docker('GET', `/containers/${encodeURIComponent(id)}/json`);
  const tail = Math.min(Math.max(Number(query.get('tail')) || 300, 0), 5000);
  const stream = await docker('GET', `/containers/${info.Id}/logs?follow=1&stdout=1&stderr=1&tail=${tail}`, undefined, { raw: true });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let pending = '';
  const onText = (buf) => {
    pending += buf.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const l of lines) res.write(`data: ${JSON.stringify(stripAnsi(l))}\n\n`);
  };
  const feed = info.Config.Tty ? onText : createDemuxer(onText);
  stream.on('data', feed);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  stream.on('end', () => {
    if (pending) res.write(`data: ${JSON.stringify(stripAnsi(pending))}\n\n`);
    res.write('event: end\ndata: "stream chiuso"\n\n');
    clearInterval(ping);
    res.end();
  });
  req.on('close', () => { clearInterval(ping); stream.destroy(); });
}

function parsePlayers(text) {
  // "There are 2 of a max of 20 players online: Steve, Alex"
  const m = text.match(/There are (\d+) (?:of a max of|out of maximum) (\d+) players online:?\s*(.*)$/is);
  if (!m) return null;
  const names = m[3].split(',').map((s) => s.trim()).filter(Boolean);
  return { online: Number(m[1]), max: Number(m[2]), names };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Vietato' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Non trovato' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = p.match(/^\/api\/servers\/([^/]+)(?:\/([a-z]+))?$/);

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  if (req.method === 'GET' && p === '/api/meta') {
    let dockerInfo = null;
    let dockerError = null;
    try {
      const v = await docker('GET', '/version');
      const info = await docker('GET', '/info');
      dockerInfo = { version: v.Version, os: info.OperatingSystem, cpus: info.NCPU, memory: info.MemTotal, name: info.Name };
    } catch (e) { dockerError = e.message; }
    let images = [];
    if (dockerInfo) {
      try {
        const imgs = await docker('GET', `/images/json?filters=${encodeURIComponent(JSON.stringify({ reference: [IMAGE] }))}`);
        images = imgs.flatMap((i) => i.RepoTags || []).filter((t) => t.startsWith(IMAGE + ':')).map((t) => t.split(':')[1]);
      } catch { /* ignora */ }
    }
    let memory = null;
    if (dockerInfo) {
      try {
        const plan = await planMemory();
        memory = { budgetMB: plan.budget, fixedMB: plan.fixed, requestedMB: plan.requested, usedMB: plan.fixed + plan.flex.reduce((a, f) => a + f.cur, 0), restartWarningS: RESTART_WARNING_S };
      } catch { /* ignora */ }
    }
    return sendJson(res, 200, { docker: dockerInfo, dockerError, memory, socket: findSocket(), serversDir: SERVERS_DIR, image: IMAGE, localTags: images });
  }

  if (req.method === 'GET' && p === '/api/servers') return sendJson(res, 200, await listServers());
  if (req.method === 'POST' && p === '/api/servers') return handleCreate(req, res);

  if (req.method === 'GET' && p === '/api/ports/suggest') {
    const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 1, 1), 100);
    const start = Number(url.searchParams.get('start')) || 25565;
    const exclude = (url.searchParams.get('exclude') || '').split(',').filter(Boolean);
    return sendJson(res, 200, await suggestPorts(count, start, exclude));
  }

  if (req.method === 'GET' && p === '/api/stats') {
    const servers = (await listServers()).filter((s) => s.state === 'running');
    const out = {};
    await Promise.all(servers.map(async (s) => { try { out[s.id] = await containerStats(s.id); } catch { /* ignora */ } }));
    return sendJson(res, 200, out);
  }

  if (req.method === 'POST' && p === '/api/bulk') {
    const { action, ids } = await readBody(req);
    if (!ACTIONS[action] && action !== 'delete') throw httpError(400, `Azione sconosciuta: ${action}`);
    const results = await Promise.all((ids || []).map(async (id) => {
      try {
        if (action === 'delete') await deleteServer(id, false); else await ACTIONS[action](id);
        return { id, ok: true };
      } catch (e) { return { id, ok: false, error: e.message }; }
    }));
    return sendJson(res, 200, { results });
  }

  if (m) {
    const id = decodeURIComponent(m[1]);
    const sub = m[2];
    if (!sub && req.method === 'GET') return sendJson(res, 200, await summarize(id));
    if (!sub && req.method === 'PUT') return handleUpdate(req, res, id);
    if (!sub && req.method === 'DELETE') return sendJson(res, 200, await deleteServer(id, url.searchParams.get('data') === '1'));
    if (sub === 'logs' && req.method === 'GET') return handleLogs(req, res, id, url.searchParams);
    if (sub === 'stats' && req.method === 'GET') return sendJson(res, 200, await containerStats(id));
    if (sub === 'command' && req.method === 'POST') {
      const { command } = await readBody(req);
      if (!command || typeof command !== 'string') throw httpError(400, 'Comando mancante');
      const r = await execInContainer(id, ['rcon-cli', command.replace(/^\//, '')]);
      return sendJson(res, 200, r);
    }
    if (sub === 'players' && req.method === 'GET') {
      const r = await execInContainer(id, ['rcon-cli', 'list']);
      return sendJson(res, 200, { raw: r.output, ...(parsePlayers(r.output) || {}), ok: r.exitCode === 0 });
    }
    if (ACTIONS[sub] && req.method === 'POST') {
      await ACTIONS[sub](id);
      return sendJson(res, 200, { ok: true });
    }
  }

  sendJson(res, 404, { error: `Endpoint non trovato: ${req.method} ${p}` });
}

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authorized(req) {
  if (!AUTH_PASSWORD) return true;
  const m = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // Confronta entrambi sempre, per non rivelare quale dei due è sbagliato.
  const userOk = sameSecret(decoded.slice(0, i), AUTH_USER);
  const passOk = sameSecret(decoded.slice(i + 1), AUTH_PASSWORD);
  return userOk && passOk;
}

if (!AUTH_PASSWORD && !LOCAL_HOSTS.includes(HOST)) {
  console.error(`Rifiuto di ascoltare su ${HOST} senza password: chi raggiunge il manager controlla Docker.`);
  console.error('Imposta MANAGER_PASSWORD (e opzionalmente MANAGER_USER) oppure HOST=127.0.0.1.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Minecraft Server Manager", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Autenticazione richiesta');
  }
  route(req, res).catch((e) => {
    if (res.headersSent) { try { res.end(); } catch { /* ignora */ } return; }
    sendJson(res, e.status || 500, { error: e.message });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Minecraft Server Manager → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Socket Docker: ${findSocket()}`);
  console.log(`Cartella dati server: ${SERVERS_DIR}`);
  console.log(AUTH_PASSWORD ? `Accesso protetto da password (utente "${AUTH_USER}")` : 'Accesso senza password (solo locale)');
});

// In container Node è il PID 1: chiude in modo pulito quando Docker manda SIGTERM.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
