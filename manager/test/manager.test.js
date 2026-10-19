'use strict';
// Test end-to-end del manager contro un finto Docker: API, password e bilanciamento della RAM.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeDocker } = require('./fake-docker');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from('admin:segreta').toString('base64')}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-'));
let fake;
let proc;

async function api(method, url, body, headers = { Authorization: AUTH }) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('ndjson')) return { status: res.status, events: text.trim().split('\n').map((l) => JSON.parse(l)) };
  return { status: res.status, body: ct.includes('json') ? JSON.parse(text) : text };
}

const servers = async () => (await api('GET', '/api/servers')).body;
const byName = async (name) => (await servers()).find((s) => s.name === name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  // 6 GiB di RAM → budget heap = (6144 − 1024) × 0.8 = 4096 MB
  fake = await startFakeDocker(path.join(tmp, 'd.sock'));
  fake.addExternal('esterno', ['MEMORY=1G', 'TYPE=PAPER']);
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      DOCKER_HOST: `unix://${path.join(tmp, 'd.sock')}`,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      SERVERS_DIR: path.join(tmp, 'servers'),
      MANAGER_PASSWORD: 'segreta',
      RESTART_WARNING: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* non ancora pronto */ }
    await sleep(100);
  }
  throw new Error('Il manager non si è avviato');
});

after(async () => {
  proc.kill();
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('healthz risponde senza password', async () => {
  const res = await fetch(`${BASE}/healthz`);
  assert.equal(res.status, 200);
});

test('senza credenziali le API rispondono 401', async () => {
  const res = await api('GET', '/api/servers', undefined, {});
  assert.equal(res.status, 401);
  const wrong = await api('GET', '/api/servers', undefined, { Authorization: `Basic ${Buffer.from('admin:no').toString('base64')}` });
  assert.equal(wrong.status, 401);
});

test('rifiuta nomi non validi e porte duplicate', async () => {
  assert.equal((await api('POST', '/api/servers', { name: 'nome non valido' })).status, 400);
  const dup = await api('POST', '/api/servers', { servers: [{ name: 'x1', port: 25600 }, { name: 'x2', port: 25600 }] });
  assert.equal(dup.status, 400);
});

test('crea un server con la heap richiesta quando la RAM basta', async () => {
  const res = await api('POST', '/api/servers', { name: 'alpha', port: 25570, env: { MEMORY: '2G', TYPE: 'PAPER' } });
  assert.equal(res.events.at(-1).type, 'done');
  const a = await byName('alpha');
  assert.equal(a.state, 'running');
  assert.equal(a.heapMB, 2048);
  assert.equal(a.env.EULA, 'TRUE');
});

test('riduce in proporzione quando la RAM non basta e avvisa i server accesi', async () => {
  // Disponibili 4096 − 1024 (esterno) = 3072 MB; richiesti 2048 + 2048 → 75 %
  const res = await api('POST', '/api/servers', { name: 'beta', port: 25571, env: { MEMORY: '2G' } });
  assert.ok(res.events.some((e) => /Ridimensiono al 75%/.test(e.msg || '')));
  const b = await byName('beta');
  assert.equal(b.heapMB, 1536);
  assert.equal(b.env.MEMORY, '1536M');
  const a = await byName('alpha');
  assert.equal(a.heapMB, 2048);
  assert.equal(a.pendingRestart.heapMB, 1536);
  assert.ok(fake.execs.some((e) => e.name === 'alpha' && /^say Riavvio tra 5 secondi/.test(e.cmd[1])));
});

test('dopo il conto alla rovescia il server viene riavviato con la nuova heap', async () => {
  await sleep(6000);
  const a = await byName('alpha');
  assert.equal(a.state, 'running');
  assert.equal(a.heapMB, 1536);
  assert.equal(a.pendingRestart, null);
  assert.equal(a.requestedMB, 2048);
});

test('fermato un server, gli altri recuperano la RAM al riavvio', async () => {
  const b = await byName('beta');
  assert.equal((await api('POST', `/api/servers/${b.id}/stop`)).status, 200);
  const a = await byName('alpha');
  assert.equal((await api('POST', `/api/servers/${a.id}/restart`)).status, 200);
  assert.equal((await byName('alpha')).heapMB, 2048);
});

test('elimina un server', async () => {
  const b = await byName('beta');
  const res = await api('DELETE', `/api/servers/${b.id}`);
  assert.equal(res.status, 200);
  assert.equal(await byName('beta'), undefined);
});
