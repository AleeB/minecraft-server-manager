'use strict';

const SCHEMA = window.MC_SCHEMA;
const FIELDS = new Map();
SCHEMA.categories.forEach((c) => c.fields.forEach((f) => FIELDS.set(f.key, { ...f, category: c.id })));
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const IMAGE_TAGS = ['latest', 'stable', 'java25', 'java21', 'java21-graalvm', 'java21-alpine', 'java17', 'java11', 'java8'];

const state = {
  servers: [],
  stats: {},
  meta: null,
  selected: new Set(),
  busy: new Set(),
  search: '',
  filter: 'all',
  loaded: false,
};

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // solo per markup statico (icone)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  restart: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 4v5h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
};

function icon(name, cls = '') {
  return h('span', { class: `icon ${cls}`, 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>` });
}

function btn(label, { icon: ic, kind = '', onClick, title, disabled, type = 'button' } = {}) {
  return h('button', { type, class: `btn ${kind}`, title: title || (label ? undefined : ''), 'aria-label': title || label, disabled: !!disabled, onclick: onClick }, ic && icon(ic), label && h('span', {}, label));
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

async function streamApi(method, url, body, onEvent) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.includes('ndjson')) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignora */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let last = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      last = JSON.parse(l);
      onEvent(last);
    }
  }
  return last;
}

function toast(msg, kind = 'info') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 7000 : 3500);
  setTimeout(() => el.remove(), kind === 'error' ? 7400 : 3900);
}

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${(b / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}

const fmtMB = (mb) => (mb >= 1024 ? `${+(mb / 1024).toFixed(1)}G` : `${mb}M`);

function fmtUptime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!(ms > 0)) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'pochi secondi';
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs} h ${m % 60} min`;
  return `${Math.floor(hrs / 24)} g ${hrs % 24} h`;
}

const stripMcCodes = (s) => String(s).replace(/§[0-9a-fk-or]/gi, '');

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast(`Copiato: ${text.length > 60 ? text.slice(0, 60) + '…' : text}`, 'success'); } catch { toast('Impossibile copiare negli appunti', 'error'); }
}

function openModal(content, { cls = '', dismissible = true, onClose, beforeClose } = {}) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const box = h('div', { class: `modal ${cls}`, role: 'dialog', 'aria-modal': 'true' }, content);
  backdrop.append(box);
  let closed = false;
  const close = (force) => {
    if (closed) return;
    if (!force && beforeClose && beforeClose() === false) return;
    closed = true;
    backdrop.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => backdrop.remove(), 150);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && dismissible && backdrop === document.querySelector('.modal-backdrop:last-of-type')) close(); };
  if (dismissible) backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  return { close, box };
}

// ---------------------------------------------------------------------------
// Stato dei server
// ---------------------------------------------------------------------------

function statusOf(s) {
  if (s.pendingRestart && isRunning(s)) {
    const sec = Math.max(0, Math.round((s.pendingRestart.at - Date.now()) / 1000));
    return { key: 'starting', label: `Riavvio RAM tra ${sec}s` };
  }
  switch (s.state) {
    case 'running':
      if (s.health === 'starting') return { key: 'starting', label: 'Avvio in corso' };
      if (s.health === 'unhealthy') return { key: 'error', label: 'Non risponde' };
      return { key: 'online', label: s.health === 'healthy' ? 'Online' : 'In esecuzione' };
    case 'restarting': return { key: 'starting', label: 'Riavvio…' };
    case 'paused': return { key: 'paused', label: 'In pausa' };
    case 'created': return { key: 'stopped', label: 'Creato' };
    case 'exited': return s.exitCode && s.exitCode !== 143 && s.exitCode !== 137 ? { key: 'error', label: `Arrestato (codice ${s.exitCode})` } : { key: 'stopped', label: 'Fermo' };
    case 'dead': return { key: 'error', label: 'Errore' };
    default: return { key: 'stopped', label: s.state };
  }
}

const isRunning = (s) => s.state === 'running' || s.state === 'restarting';

async function refreshServers() {
  if (state.meta && !state.meta.docker) { state.servers = []; state.loaded = true; renderDashboard(); return; }
  try {
    state.servers = await api('GET', '/api/servers');
    const ids = new Set(state.servers.map((s) => s.id));
    for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
    state.loaded = true;
  } catch (e) {
    state.servers = [];
    state.loaded = true;
  }
  renderDashboard();
}

async function refreshStats() {
  if (!state.servers.some(isRunning)) { state.stats = {}; return; }
  try { state.stats = await api('GET', '/api/stats'); renderDashboard(); } catch { /* ignora */ }
}

async function refreshMeta() {
  const wasDown = !state.meta?.docker;
  try { state.meta = await api('GET', '/api/meta'); } catch (e) { state.meta = { dockerError: e.message }; }
  renderHeader();
  if (wasDown && state.meta.docker && state.loaded) refreshServers();
}

// ---------------------------------------------------------------------------
// Header & dashboard
// ---------------------------------------------------------------------------

function renderHeader() {
  const m = state.meta;
  const pill = $('#docker-status');
  const banner = $('#docker-banner');
  if (!m) return;
  if (m.docker) {
    pill.className = 'pill ok';
    pill.replaceChildren(h('i', { class: 'dot' }), `Docker ${m.docker.version}`, h('span', { class: 'muted' }, ` · ${m.docker.os}`));
    pill.title = `${m.socket}\n${m.docker.cpus} CPU · ${fmtBytes(m.docker.memory)} RAM`;
    banner.hidden = true;
  } else {
    pill.className = 'pill bad';
    pill.replaceChildren(h('i', { class: 'dot' }), 'Docker offline');
    banner.hidden = false;
    banner.replaceChildren(
      h('strong', {}, 'Docker non raggiungibile. '),
      (m.dockerError || '').replace(/^Docker non raggiungibile\s*/, '').replace(/\s*OrbStack\/Docker è avviato\?$/, ''),
      h('span', { class: 'muted' }, ` Avvia OrbStack (o Docker Desktop) e la pagina si ricollegherà da sola.`),
    );
  }
}

function filteredServers() {
  const q = state.search.trim().toLowerCase();
  return state.servers.filter((s) => {
    if (state.filter === 'running' && !isRunning(s)) return false;
    if (state.filter === 'stopped' && isRunning(s)) return false;
    if (!q) return true;
    return [s.name, s.type, s.version, s.motd, String(s.port)].some((v) => String(v || '').toLowerCase().includes(q));
  });
}

function renderDashboard() {
  const list = filteredServers();
  const running = state.servers.filter(isRunning);
  const stats = Object.values(state.stats);
  const mem = stats.reduce((a, s) => a + s.memUsage, 0);
  const cpu = stats.reduce((a, s) => a + s.cpu, 0);

  $('#summary').replaceChildren(
    summaryTile('Server', state.servers.length),
    summaryTile('Attivi', running.length, 'online'),
    summaryTile('RAM in uso', running.length ? fmtBytes(mem) : '—'),
    memoryTile(),
    summaryTile('CPU', running.length ? `${cpu.toFixed(0)}%` : '—'),
  );

  const sel = [...state.selected].map((id) => state.servers.find((s) => s.id === id)).filter(Boolean);
  const visibleIds = list.map((s) => s.id);
  const allSel = visibleIds.length > 0 && visibleIds.every((id) => state.selected.has(id));
  const selAll = $('#select-all');
  selAll.checked = allSel;
  selAll.indeterminate = !allSel && visibleIds.some((id) => state.selected.has(id));
  $('#bulk-count').textContent = sel.length ? `${sel.length} selezionati` : 'Seleziona';
  for (const b of document.querySelectorAll('[data-bulk]')) b.disabled = sel.length === 0;

  const grid = $('#grid');
  if (!state.loaded) { grid.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'spinner' }))); return; }
  if (state.servers.length === 0) {
    grid.replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'empty-art', html: CUBE_SVG }),
      h('h2', {}, 'Nessun server Minecraft'),
      h('p', {}, state.meta && !state.meta.docker ? 'Avvia Docker per vedere e creare i server.' : 'Crea il primo server o avviane molti in una volta sola.'),
      btn('Nuovo server', { icon: 'plus', kind: 'primary', onClick: () => openEditor({ mode: 'create' }) }),
    ));
    return;
  }
  if (list.length === 0) { grid.replaceChildren(h('div', { class: 'empty small' }, h('p', {}, 'Nessun server corrisponde al filtro.'))); return; }
  grid.replaceChildren(...list.map(serverCard));
}

function memoryTile() {
  const m = state.meta?.memory;
  if (!m) return summaryTile('Heap allocata', '—');
  const over = m.requestedMB > m.budgetMB - m.fixedMB;
  return h('div', { class: `tile${over ? ' warn' : ''}`, title: `Budget heap = (RAM Docker − riserva) × quota heap. Se i server accesi chiedono più del budget, la RAM viene divisa in proporzione.${m.fixedMB ? `\nContainer esterni: ${fmtMB(m.fixedMB)}` : ''}` },
    h('span', { class: 'tile-label' }, 'Heap allocata'),
    h('strong', { class: 'tile-value' }, fmtMB(m.usedMB), h('small', { class: 'muted' }, ` / ${fmtMB(m.budgetMB)}`)));
}

function summaryTile(label, value, cls = '') {
  return h('div', { class: `tile ${cls}` }, h('span', { class: 'tile-label' }, label), h('strong', { class: 'tile-value' }, value));
}

function meter(label, pct, text) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-top' }, h('span', {}, label), h('span', { class: 'mono' }, text)),
    h('div', { class: 'meter-track' }, h('div', { class: `meter-fill ${p > 85 ? 'hot' : p > 65 ? 'warm' : ''}`, style: `width:${p}%` })));
}

function serverCard(s) {
  const st = statusOf(s);
  const running = isRunning(s);
  const busy = state.busy.has(s.id);
  const stats = state.stats[s.id];
  const address = s.port ? `${location.hostname}:${s.port}` : null;
  const selected = state.selected.has(s.id);

  return h('article', { class: `card st-${st.key}${selected ? ' selected' : ''}${busy ? ' busy' : ''}` },
    h('header', { class: 'card-head' },
      h('label', { class: 'check', title: 'Seleziona' },
        h('input', { type: 'checkbox', checked: selected, onchange: (e) => { e.target.checked ? state.selected.add(s.id) : state.selected.delete(s.id); renderDashboard(); } })),
      h('div', { class: 'card-title' },
        h('h3', { title: s.name }, s.name),
        h('div', { class: 'chips' },
          h('span', { class: 'chip type' }, s.type),
          h('span', { class: 'chip' }, s.version),
          !s.managed && h('span', { class: 'chip warn', title: 'Container non creato da questo manager: puoi avviarlo, fermarlo e duplicarlo, ma non modificarlo.' }, s.compose ? `compose · ${s.compose}` : 'esterno'))),
      h('span', { class: `badge ${st.key}` }, busy ? h('span', { class: 'spinner tiny' }) : h('i', { class: 'dot' }), st.label)),
    s.motd ? h('p', { class: 'motd', title: s.motd }, stripMcCodes(s.motd)) : h('p', { class: 'motd muted' }, 'Nessun MOTD'),
    h('dl', { class: 'facts' },
      h('div', {}, h('dt', {}, 'Indirizzo'), h('dd', {}, address
        ? h('button', { class: 'linkish mono', title: 'Copia indirizzo', onclick: () => copyText(address) }, address)
        : '—')),
      h('div', {}, h('dt', {}, 'Heap Java'), h('dd', { class: 'mono' },
        s.pendingRestart ? `${s.memory} → ${fmtMB(s.pendingRestart.heapMB)}` : s.memory || '1G',
        s.requestedMB && s.heapMB < s.requestedMB && h('span', { class: 'reduced', title: `Richiesti ${fmtMB(s.requestedMB)}: ridotta per far stare tutti i server accesi nella RAM disponibile` }, ` (di ${fmtMB(s.requestedMB)})`))),
      h('div', {}, h('dt', {}, 'Uptime'), h('dd', {}, running ? fmtUptime(s.startedAt) : '—')),
      h('div', {}, h('dt', {}, 'Giocatori max'), h('dd', { class: 'mono' }, s.maxPlayers || '20'))),
    running && stats
      ? h('div', { class: 'meters' },
        meter('CPU', stats.cpu / (state.meta?.docker?.cpus || 1), `${stats.cpu.toFixed(0)}%`),
        meter('RAM', stats.memLimit ? (stats.memUsage / stats.memLimit) * 100 : 0, `${fmtBytes(stats.memUsage)} / ${fmtBytes(stats.memLimit)}`))
      : h('div', { class: 'meters placeholder' }, running ? 'Raccolta statistiche…' : s.dataPath ? h('span', { class: 'mono path', title: s.dataPath }, s.dataPath) : ''),
    h('footer', { class: 'card-actions' },
      running
        ? btn('Ferma', { icon: 'stop', kind: 'danger-soft', disabled: busy, onClick: () => runAction(s, 'stop') })
        : s.state === 'paused'
          ? btn('Riprendi', { icon: 'play', kind: 'primary', disabled: busy, onClick: () => runAction(s, 'unpause') })
          : btn('Avvia', { icon: 'play', kind: 'primary', disabled: busy, onClick: () => runAction(s, 'start') }),
      btn('', { icon: 'restart', kind: 'icon-only', title: 'Riavvia', disabled: busy || !running, onClick: () => runAction(s, 'restart') }),
      btn('Console', { icon: 'terminal', disabled: busy, onClick: () => openConsole(s) }),
      h('span', { class: 'spacer' }),
      btn('', { icon: 'edit', kind: 'icon-only', title: s.managed ? 'Modifica impostazioni' : 'Non gestito dal manager: usa Duplica', disabled: busy || !s.managed, onClick: () => openEditor({ mode: 'edit', server: s }) }),
      btn('', { icon: 'copy', kind: 'icon-only', title: 'Duplica', disabled: busy, onClick: () => openEditor({ mode: 'create', from: s }) }),
      btn('', { icon: 'trash', kind: 'icon-only danger', title: 'Elimina', disabled: busy, onClick: () => confirmDelete([s]) })),
  );
}

const ACTION_LABEL = { start: 'avviato', stop: 'fermato', restart: 'riavviato', unpause: 'ripreso', pause: 'messo in pausa', kill: 'terminato' };

async function runAction(s, action) {
  state.busy.add(s.id);
  renderDashboard();
  try {
    await api('POST', `/api/servers/${s.id}/${action}`);
    toast(`${s.name} ${ACTION_LABEL[action] || action}`, 'success');
  } catch (e) {
    toast(`${s.name}: ${e.message}`, 'error');
  } finally {
    state.busy.delete(s.id);
    await refreshServers();
    refreshMeta();
  }
}

async function runBulk(action) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (action === 'delete') return confirmDelete(ids.map((id) => state.servers.find((s) => s.id === id)).filter(Boolean));
  ids.forEach((id) => state.busy.add(id));
  renderDashboard();
  try {
    const { results } = await api('POST', '/api/bulk', { action, ids });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      for (const f of failed) toast(`${state.servers.find((s) => s.id === f.id)?.name || f.id}: ${f.error}`, 'error');
    } else toast(`${results.length} server ${ACTION_LABEL[action] || action}`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    ids.forEach((id) => state.busy.delete(id));
    await refreshServers();
    refreshMeta();
  }
}

function confirmDelete(servers) {
  const managed = servers.filter((s) => s.managed);
  const names = servers.map((s) => s.name);
  let removeData = false;
  const confirmInput = h('input', { class: 'input', placeholder: 'elimina', autocomplete: 'off', oninput: update });
  const confirmRow = h('div', { class: 'confirm-row', hidden: true },
    h('label', {}, 'Scrivi ', h('code', {}, 'elimina'), ' per confermare la cancellazione definitiva dei dati'), confirmInput);
  const okBtn = btn(`Elimina ${servers.length > 1 ? `${servers.length} server` : ''}`.trim(), { icon: 'trash', kind: 'danger', onClick: go });

  function update() {
    confirmRow.hidden = !removeData;
    okBtn.disabled = removeData && confirmInput.value.trim().toLowerCase() !== 'elimina';
  }

  const m = openModal(h('div', { class: 'dialog' },
    h('h2', {}, servers.length > 1 ? `Eliminare ${servers.length} server?` : `Eliminare "${names[0]}"?`),
    h('p', {}, 'Il container verrà fermato (con salvataggio del mondo) e rimosso.'),
    servers.length > 1 && h('ul', { class: 'name-list' }, names.map((n) => h('li', { class: 'mono' }, n))),
    managed.length > 0 && h('label', { class: 'switch-row danger' },
      h('input', { type: 'checkbox', onchange: (e) => { removeData = e.target.checked; update(); } }),
      h('span', {}, h('strong', {}, 'Elimina anche la cartella dati'), h('small', {}, 'Mondo, plugin e configurazioni verranno cancellati per sempre. Vale solo per le cartelle dentro ', h('code', {}, state.meta?.serversDir || 'servers/'), '.'))),
    confirmRow,
    h('div', { class: 'modal-foot' }, btn('Annulla', { onClick: () => m.close() }), okBtn)), { cls: 'small' });

  async function go() {
    m.close(true);
    servers.forEach((s) => state.busy.add(s.id));
    renderDashboard();
    await Promise.all(servers.map(async (s) => {
      try {
        const r = await api('DELETE', `/api/servers/${s.id}?data=${removeData && s.managed ? 1 : 0}`);
        toast(`${s.name} eliminato${r.dataRemoved ? ' insieme ai dati' : ''}`, 'success');
      } catch (e) { toast(`${s.name}: ${e.message}`, 'error'); }
      state.busy.delete(s.id);
      state.selected.delete(s.id);
    }));
    refreshServers();
  }
}

// ---------------------------------------------------------------------------
// Editor impostazioni (creazione, modifica, creazione multipla)
// ---------------------------------------------------------------------------

function newDraft() {
  return {
    name: '', port: 25565, imageTag: 'latest', dataPath: '', restart: 'unless-stopped',
    memoryLimit: '', cpus: '', exposeRcon: false, rconHostPort: '', extraPorts: [], autoStart: true,
    env: { TYPE: 'PAPER', VERSION: 'LATEST', MEMORY: '2G', TZ: 'Europe/Rome' },
    customEnv: [],
  };
}

const listToLines = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean).join('\n');
const linesToList = (v) => String(v).split(/[\n,]/).map((s) => s.trim()).filter(Boolean).join(',');

function settingsFromServer(s) {
  const d = newDraft();
  d.env = {};
  if (s.config) {
    Object.assign(d, JSON.parse(JSON.stringify(s.config)));
    d.env = { ...(s.config.env || {}) };
    d.customEnv = [...(s.config.customEnv || [])];
  } else {
    for (const [k, v] of Object.entries(s.userEnv || {})) {
      if (k === 'EULA') continue;
      if (FIELDS.has(k)) d.env[k] = v; else d.customEnv.push({ key: k, value: v });
    }
    d.port = s.port || 25565;
    d.imageTag = (s.image.split(':')[1]) || 'latest';
  }
  for (const [k, v] of Object.entries(d.env)) if (FIELDS.get(k)?.list) d.env[k] = listToLines(v);
  return d;
}

function buildConfig(d) {
  const env = {};
  for (const [k, v] of Object.entries(d.env)) {
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const f = FIELDS.get(k);
    env[k] = f?.list ? linesToList(v) : f?.type === 'textarea' ? String(v) : String(v).trim();
  }
  return {
    name: d.name.trim(),
    port: Number(d.port),
    imageTag: (d.imageTag || 'latest').trim(),
    dataPath: (d.dataPath || '').trim(),
    restart: d.restart,
    memoryLimit: (d.memoryLimit || '').trim(),
    cpus: d.cpus === '' ? '' : Number(d.cpus),
    exposeRcon: !!d.exposeRcon,
    rconHostPort: d.exposeRcon ? Number(d.rconHostPort) || '' : '',
    extraPorts: d.extraPorts.filter((p) => p.host && p.container).map((p) => ({ host: Number(p.host), container: Number(p.container), proto: p.proto || 'tcp' })),
    autoStart: d.autoStart !== false,
    env,
    customEnv: d.customEnv.filter((e) => e.key && e.key.trim()).map((e) => ({ key: e.key.trim(), value: e.value ?? '' })),
  };
}

async function suggestPorts(count, start = 25565, exclude = []) {
  try { return (await api('GET', `/api/ports/suggest?count=${count}&start=${start}&exclude=${exclude.join(',')}`)).ports; } catch { return []; }
}

function openEditor({ mode, server, from }) {
  const isEdit = mode === 'edit';
  const draft = isEdit ? settingsFromServer(server) : newDraft();
  if (from) {
    const src = settingsFromServer(from);
    Object.assign(draft, src, { name: `${from.name}-copia`, dataPath: '' });
  }
  const originalSig = JSON.stringify(buildConfig(draft));
  const rows = []; // { key, el, field, set }
  const sectionEls = new Map();
  const navCounts = new Map();

  // --- Controlli ---------------------------------------------------------
  function setEnv(key, v) {
    if (v === undefined || v === null || v === '') delete draft.env[key]; else draft.env[key] = v;
    afterChange();
  }

  function control(f) {
    const id = `f_${f.key}`;
    const cur = draft.env[f.key] ?? '';
    if (f.type === 'bool') {
      const dl = f.default === undefined ? '' : f.default ? ' (Sì)' : ' (No)';
      const choices = [['', `Predefinito${dl}`], ['TRUE', 'Sì'], ['FALSE', 'No']];
      const wrap = h('div', { class: 'seg', role: 'radiogroup', id });
      const set = (v) => {
        const norm = v === '' || v === undefined ? '' : String(v).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE';
        for (const b of wrap.children) b.setAttribute('aria-checked', String(b.dataset.v === norm));
      };
      for (const [v, label] of choices) {
        wrap.append(h('button', { type: 'button', role: 'radio', 'data-v': v, class: v === '' ? 'seg-default' : '', onclick: () => { set(v); setEnv(f.key, v); } }, label));
      }
      set(cur);
      return { el: wrap, set };
    }
    if (f.type === 'select') {
      const dflt = f.default !== undefined ? flatOptions(f).find((o) => o.value === f.default) : null;
      const sel = h('select', { class: 'input', id, onchange: (e) => setEnv(f.key, e.target.value) },
        h('option', { value: '' }, dflt ? `Predefinito (${dflt.label})` : 'Predefinito'),
        f.options.map((o) => (o.group
          ? h('optgroup', { label: o.group }, o.items.map((i) => h('option', { value: i.value }, i.label)))
          : h('option', { value: o.value }, o.label))));
      const set = (v) => { sel.value = v ?? ''; };
      set(cur);
      return { el: sel, set };
    }
    if (f.type === 'textarea') {
      const ta = h('textarea', { class: 'input', id, rows: f.list ? 3 : 4, placeholder: f.placeholder || '', spellcheck: 'false', oninput: (e) => setEnv(f.key, e.target.value) });
      const set = (v) => { ta.value = v ?? ''; };
      set(cur);
      return { el: ta, set };
    }
    const input = h('input', {
      class: 'input', id, type: f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text',
      placeholder: f.placeholder || '', min: f.min, max: f.max, autocomplete: 'off', spellcheck: 'false',
      list: f.suggestions ? `${id}_list` : undefined,
      oninput: (e) => setEnv(f.key, e.target.value),
    });
    const set = (v) => { input.value = v ?? ''; };
    set(cur);
    const parts = [input];
    if (f.suggestions) parts.push(h('datalist', { id: `${id}_list` }, f.suggestions.map((s) => h('option', { value: s }))));
    if (f.type === 'password') {
      parts.push(btn('', { icon: 'eye', kind: 'icon-only ghost', title: 'Mostra/nascondi', onClick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } }));
    }
    return { el: parts.length > 1 ? h('div', { class: 'input-group' }, parts) : input, set };
  }

  function flatOptions(f) { return f.options.flatMap((o) => (o.group ? o.items : [o])); }

  function fieldRow(f) {
    const c = control(f);
    const resetBtn = h('button', { type: 'button', class: 'reset', title: 'Ripristina al valore predefinito', onclick: () => { c.set(''); setEnv(f.key, ''); } }, icon('reset'), 'ripristina');
    const el = h('div', { class: 'field', 'data-key': f.key },
      h('div', { class: 'field-meta' },
        h('label', { for: `f_${f.key}` }, f.label),
        h('div', { class: 'field-sub' }, h('code', { class: 'envkey' }, f.key), resetBtn),
        f.help && h('p', { class: 'help' }, f.help)),
      h('div', { class: 'field-control' }, c.el));
    rows.push({ key: f.key, el, field: f, set: c.set, text: `${f.label} ${f.key} ${f.help || ''}`.toLowerCase() });
    return el;
  }

  // --- Sezione Docker ------------------------------------------------------
  function dockerRow(label, sub, help, controlEl, searchText = '') {
    const el = h('div', { class: 'field' },
      h('div', { class: 'field-meta' }, h('label', {}, label), sub && h('div', { class: 'field-sub' }, h('code', { class: 'envkey' }, sub)), help && h('p', { class: 'help' }, help)),
      h('div', { class: 'field-control' }, controlEl));
    rows.push({ key: null, el, field: null, text: `${label} ${sub || ''} ${help || ''} ${searchText}`.toLowerCase() });
    return el;
  }

  function trackRow(el, text) {
    rows.push({ key: null, el, field: null, text });
    return el;
  }

  function textInput(obj, key, props = {}) {
    return h('input', { class: 'input', value: obj[key] ?? '', autocomplete: 'off', spellcheck: 'false', ...props, oninput: (e) => { obj[key] = e.target.value; afterChange(); props.onupdate && props.onupdate(); } });
  }

  function toggle(obj, key, onChange) {
    return h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; afterChange(); onChange && onChange(); } }), h('span', { class: 'toggle-ui' }));
  }

  const extraPortsList = h('div', { class: 'ports-list' });
  function renderExtraPorts() {
    extraPortsList.replaceChildren(
      ...draft.extraPorts.map((p, i) => h('div', { class: 'port-row' },
        h('input', { class: 'input mono', type: 'number', placeholder: 'host', value: p.host ?? '', oninput: (e) => { p.host = e.target.value; afterChange(); } }),
        h('span', { class: 'muted' }, '→'),
        h('input', { class: 'input mono', type: 'number', placeholder: 'container', value: p.container ?? '', oninput: (e) => { p.container = e.target.value; afterChange(); } }),
        h('select', { class: 'input', onchange: (e) => { p.proto = e.target.value; afterChange(); } }, ['tcp', 'udp'].map((v) => h('option', { value: v, selected: (p.proto || 'tcp') === v }, v.toUpperCase()))),
        btn('', { icon: 'x', kind: 'icon-only ghost', title: 'Rimuovi', onClick: () => { draft.extraPorts.splice(i, 1); renderExtraPorts(); afterChange(); } }))),
      h('div', { class: 'row wrap' },
        btn('Aggiungi porta', { icon: 'plus', kind: 'small', onClick: () => { draft.extraPorts.push({ host: '', container: '', proto: 'tcp' }); renderExtraPorts(); } }),
        ...[['Bedrock / Geyser', 19132, 'udp'], ['Voice chat', 24454, 'udp'], ['BlueMap', 8100, 'tcp'], ['Dynmap', 8123, 'tcp']].map(([label, port, proto]) =>
          btn(label, { kind: 'small ghost', onClick: () => { draft.extraPorts.push({ host: port, container: port, proto }); renderExtraPorts(); afterChange(); } }))),
    );
  }
  renderExtraPorts();

  function dockerSection() {
    const portInput = textInput(draft, 'port', { type: 'number', min: 1, max: 65535, class: 'input mono' });
    const nameInput = textInput(draft, 'name', { placeholder: 'survival', class: 'input mono', onupdate: () => { dataInput.placeholder = `${state.meta?.serversDir || '…/servers'}/${draft.name || '<nome>'}`; } });
    let dataInput;
    const rconPort = textInput(draft, 'rconHostPort', { type: 'number', placeholder: '25575', class: 'input mono' });
    const rconWrap = h('div', { class: 'row' }, toggle(draft, 'exposeRcon', () => { rconPort.disabled = !draft.exposeRcon; }), rconPort);
    rconPort.disabled = !draft.exposeRcon;
    const serversDir = state.meta?.serversDir || '…/servers';

    const children = [
      dockerRow('Nome container', null, 'Identifica il server in Docker e nella cartella dati.', nameInput),
      dockerRow('Porta del server', '→ 25565/tcp', 'Porta su cui i giocatori si collegano (indirizzo:porta).',
        h('div', { class: 'row' }, portInput, btn('Trova libera', { kind: 'small', onClick: async () => {
          const [p] = await suggestPorts(1);
          if (p) { draft.port = p; portInput.value = p; afterChange(); }
        } }))),
    ];
    const tagInput = textInput(draft, 'imageTag', { list: 'image-tags', class: 'input mono', placeholder: 'latest' });
    children.push(
      dockerRow('Tag immagine', 'itzg/minecraft-server:<tag>', 'Determina la versione di Java. "latest" va bene per le versioni recenti; usa java8 o java17 per versioni vecchie e modpack datati.',
        h('div', {}, tagInput, h('datalist', { id: 'image-tags' }, [...new Set([...IMAGE_TAGS, ...(state.meta?.localTags || [])])].map((t) => h('option', { value: t }))))),
      dockerRow('Cartella dati', '→ /data', `Mondo, plugin e configurazioni. Vuoto = ${serversDir}/<nome>.`,
        dataInput = textInput(draft, 'dataPath', { placeholder: `${serversDir}/${draft.name || '<nome>'}`, class: 'input mono', disabled: isEdit && !!server?.config, title: isEdit ? 'La cartella dati non si cambia in modifica: duplica il server per usarne un\'altra.' : '' })),
      dockerRow('Riavvio automatico', 'restart', 'Cosa fa Docker quando il server si chiude o il computer si riavvia.',
        h('select', { class: 'input', onchange: (e) => { draft.restart = e.target.value; afterChange(); } },
          [['unless-stopped', 'Sempre, tranne se fermato a mano'], ['always', 'Sempre'], ['on-failure', 'Solo in caso di crash'], ['no', 'Mai']]
            .map(([v, l]) => h('option', { value: v, selected: draft.restart === v }, l)))),
      dockerRow('Limite RAM container', 'mem_limit', 'Es. 5g. Deve superare la memoria heap di almeno ~1 GB, altrimenti Docker uccide il server. Vuoto = nessun limite.',
        textInput(draft, 'memoryLimit', { placeholder: 'nessun limite', class: 'input mono' })),
      dockerRow('Limite CPU', 'cpus', 'Numero di core utilizzabili (es. 2 o 1.5). Vuoto = nessun limite.',
        textInput(draft, 'cpus', { type: 'number', step: '0.5', min: 0, placeholder: 'nessun limite', class: 'input mono' })),
      dockerRow('Esponi RCON sull\'host', '→ 25575/tcp', 'Per usare client RCON esterni. La console del manager funziona anche senza.', rconWrap),
      dockerRow('Porte aggiuntive', null, 'Per plugin come Geyser (Bedrock), mappe web o voice chat.', extraPortsList, 'porte geyser bedrock bluemap dynmap'),
      dockerRow(isEdit ? 'Avvia dopo il salvataggio' : 'Avvia subito', null, isEdit ? 'Se il server era acceso viene comunque riavviato.' : 'Avvia il container appena creato.', toggle(draft, 'autoStart')),
    );
    return children;
  }

  // --- Variabili personalizzate -------------------------------------------
  const customList = h('div', { class: 'custom-list' });
  function renderCustom() {
    customList.replaceChildren(
      ...draft.customEnv.map((e, i) => h('div', { class: 'custom-row' },
        h('input', { class: 'input mono', placeholder: 'NOME_VARIABILE', value: e.key, oninput: (ev) => { e.key = ev.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'); ev.target.value = e.key; afterChange(); } }),
        h('input', { class: 'input mono', placeholder: 'valore', value: e.value, oninput: (ev) => { e.value = ev.target.value; afterChange(); } }),
        btn('', { icon: 'x', kind: 'icon-only ghost', title: 'Rimuovi', onClick: () => { draft.customEnv.splice(i, 1); renderCustom(); afterChange(); } }))),
      btn('Aggiungi variabile', { icon: 'plus', kind: 'small', onClick: () => { draft.customEnv.push({ key: '', value: '' }); renderCustom(); } }),
    );
  }
  renderCustom();

  // --- Layout --------------------------------------------------------------
  const sections = [
    { id: 'docker', title: 'Container Docker', icon: '🐳', description: 'Nome, porte, risorse e cartella dati del container.', build: dockerSection },
    ...SCHEMA.categories.map((c) => ({ ...c, build: () => c.fields.map(fieldRow) })),
    { id: 'custom', title: 'Variabili personalizzate', icon: '✳️', description: 'Qualsiasi altra variabile d\'ambiente supportata dall\'immagine o dai plugin.', build: () => [trackRow(h('div', { class: 'field full' }, customList), 'variabili personalizzate custom env')] },
  ];

  const nav = h('nav', { class: 'editor-nav' });
  const body = h('div', { class: 'editor-body' });
  for (const sec of sections) {
    const count = h('span', { class: 'nav-count' });
    navCounts.set(sec.id, count);
    nav.append(h('a', { href: `#sec-${sec.id}`, 'data-sec': sec.id, onclick: (e) => { e.preventDefault(); sectionEls.get(sec.id).scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
      h('span', { class: 'nav-ico' }, sec.icon), h('span', { class: 'nav-title' }, sec.title), count));
    const el = h('section', { class: 'editor-section', id: `sec-${sec.id}`, 'data-sec': sec.id },
      h('header', {}, h('h3', {}, h('span', { class: 'nav-ico' }, sec.icon), sec.title), sec.description && h('p', { class: 'muted' }, sec.description)),
      h('div', { class: 'fields' }, sec.build()));
    sectionEls.set(sec.id, el);
    body.append(el);
  }
  const noResults = h('div', { class: 'empty small', hidden: true }, h('p', {}, 'Nessuna impostazione trovata.'));
  body.append(noResults);

  const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Cerca tra tutte le impostazioni (es. whitelist, seed, RAM)…', oninput: applySearch });
  function applySearch() {
    const q = searchInput.value.trim().toLowerCase();
    for (const r of rows) r.el.classList.toggle('search-hidden', !!q && !r.text.includes(q));
    let any = false;
    for (const [id, el] of sectionEls) {
      const visible = [...el.querySelectorAll('.field')].some((f) => !f.classList.contains('search-hidden') && !f.classList.contains('cond-hidden'));
      const hide = !!q && !visible;
      el.hidden = hide;
      nav.querySelector(`[data-sec="${id}"]`).classList.toggle('dim', hide);
      if (!hide) any = true;
    }
    noResults.hidden = any;
  }

  function refreshVisibility() {
    for (const r of rows) {
      if (!r.field) continue;
      const visible = !r.field.show || r.field.show(draft.env);
      r.el.classList.toggle('cond-hidden', !visible);
      r.el.classList.toggle('modified', draft.env[r.key] !== undefined && draft.env[r.key] !== '');
    }
    for (const c of SCHEMA.categories) {
      const n = c.fields.filter((f) => draft.env[f.key] !== undefined && draft.env[f.key] !== '').length;
      navCounts.get(c.id).textContent = n ? String(n) : '';
      const sec = sectionEls.get(c.id);
      const anyVisible = c.fields.some((f) => !f.show || f.show(draft.env));
      sec.classList.toggle('section-empty', !anyVisible);
    }
    const cn = draft.customEnv.filter((e) => e.key).length;
    navCounts.get('custom').textContent = cn ? String(cn) : '';
  }

  function afterChange() {
    refreshVisibility();
    if (searchInput.value) applySearch();
    updatePreview();
  }

  // Preset & modelli
  const presetSelect = h('select', { class: 'input', onchange: (e) => applyTemplate(e.target.value) },
    h('option', { value: '' }, 'Applica un modello…'),
    h('optgroup', { label: 'Preset' }, SCHEMA.presets.map((p) => h('option', { value: `preset:${p.id}` }, `${p.name} — ${p.desc}`))),
    state.servers.length > 0 && h('optgroup', { label: 'Copia impostazioni da un server' }, state.servers.filter((s) => !isEdit || s.id !== server.id).map((s) => h('option', { value: `server:${s.id}` }, `${s.name} (${s.type} ${s.version})`))));

  function applyTemplate(v) {
    presetSelect.value = '';
    if (!v) return;
    const [kind, id] = v.split(':');
    if (kind === 'preset') {
      const p = SCHEMA.presets.find((x) => x.id === id);
      draft.env = { TZ: draft.env.TZ || 'Europe/Rome', ...p.env };
      toast(`Preset "${p.name}" applicato`, 'success');
    } else {
      const s = state.servers.find((x) => x.id === id);
      const src = settingsFromServer(s);
      draft.env = src.env;
      draft.customEnv = src.customEnv;
      Object.assign(draft, { imageTag: src.imageTag, memoryLimit: src.memoryLimit || '', cpus: src.cpus ?? '', restart: src.restart || draft.restart });
      renderCustom();
      toast(`Impostazioni copiate da ${s.name}`, 'success');
    }
    for (const r of rows) if (r.set) r.set(draft.env[r.key] ?? '');
    afterChange();
  }

  // Anteprima compose
  const preview = h('pre', { class: 'compose mono' });
  const previewPane = h('aside', { class: 'compose-pane', hidden: true },
    h('div', { class: 'compose-head' }, h('strong', {}, 'docker-compose.yml'), btn('Copia', { icon: 'copy', kind: 'small', onClick: () => copyText(preview.textContent) })),
    preview);
  function updatePreview() {
    if (previewPane.hidden) return;
    preview.textContent = toCompose([buildConfig(draft)]);
  }

  function setPreviewVisible(on) {
    previewPane.hidden = !on;
    content.classList.toggle('with-preview', on);
    try { localStorage.setItem('mcm.showYaml', on ? '1' : '0'); } catch { /* ignora */ }
    updatePreview();
  }

  const saveBtn = btn(isEdit ? 'Salva e ricrea' : 'Crea server', { icon: isEdit ? 'restart' : 'plus', kind: 'primary', onClick: save });
  const title = isEdit ? `Modifica ${server.name}` : from ? `Duplica ${from.name}` : 'Nuovo server';

  const content = h('div', { class: 'editor' },
    h('header', { class: 'editor-head' },
      h('div', { class: 'editor-title' }, h('h2', {}, title), h('p', { class: 'muted' }, isEdit ? 'Il container verrà ricreato con le nuove impostazioni. Il mondo e i file in /data restano invariati.' : 'Ogni campo lasciato su "Predefinito" usa il valore di default dell\'immagine itzg/minecraft-server.')),
      btn('', { icon: 'x', kind: 'icon-only ghost', title: 'Chiudi', onClick: () => m.close() })),
    h('div', { class: 'editor-tools' }, h('div', { class: 'search-wrap' }, icon('search'), searchInput), presetSelect,
      h('label', { class: 'inline-check yaml-toggle', title: 'Mostra l\'anteprima docker-compose.yml' },
        h('input', { type: 'checkbox', checked: yamlPref(), onchange: (e) => setPreviewVisible(e.target.checked) }),
        icon('code'), 'Mostra YAML')),
    h('div', { class: 'editor-main' }, nav, body, previewPane),
    h('footer', { class: 'editor-foot' },
      h('span', { class: 'muted small-text' }, 'EULA di Mojang accettata automaticamente (EULA=TRUE).'),
      h('span', { class: 'spacer' }),
      btn('Annulla', { onClick: () => m.close() }), saveBtn));

  if (yamlPref()) setPreviewVisible(true);

  const m = openModal(content, {
    cls: 'editor-modal',
    beforeClose: () => JSON.stringify(buildConfig(draft)) === originalSig || confirm('Chiudere senza salvare le modifiche?'),
  });

  // Evidenzia la sezione visibile nella navigazione
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.sec === e.target.dataset.sec));
      }
    }
  }, { root: body, rootMargin: '0px 0px -70% 0px' });
  sectionEls.forEach((el) => observer.observe(el));

  refreshVisibility();
  if (!isEdit) {
    suggestPorts(1).then(([p]) => {
      if (p && Number(draft.port) === 25565 && p !== 25565) { draft.port = p; const pi = body.querySelector('input[type=number]'); if (pi) pi.value = p; }
      if (!draft.name) {
        let i = state.servers.length + 1;
        while (state.servers.some((s) => s.name === `server-${i}`)) i++;
        draft.name = `server-${i}`;
        const ni = body.querySelector('#sec-docker input');
        if (ni) ni.value = draft.name;
      }
    });
  }
  setTimeout(() => body.querySelector('#sec-docker input')?.focus(), 60);

  async function save() {
    const cfg = buildConfig(draft);
    if (!NAME_RE.test(cfg.name)) return toast('Nome non valido: usa lettere, numeri, "-", "_" o "." (max 63)', 'error');
    if (!(cfg.port >= 1 && cfg.port <= 65535)) return toast('Porta non valida', 'error');
    if (!isEdit && state.servers.some((s) => s.name === cfg.name)) return toast(`Esiste già un server chiamato "${cfg.name}"`, 'error');
    const payload = cfg.env.ENABLE_AUTOPAUSE === 'TRUE' && cfg.env.MAX_TICK_TIME === undefined ? withEnv(cfg, { MAX_TICK_TIME: '-1' }) : cfg;

    m.close(true);
    const prog = progressModal(isEdit ? `Aggiornamento di ${server.name}` : `Creazione di ${cfg.name}`);
    try {
      const last = await streamApi(isEdit ? 'PUT' : 'POST', isEdit ? `/api/servers/${server.id}` : '/api/servers', payload, (ev) => {
        if (ev.type === 'progress') prog.line(ev.msg, ev.level);
        if (ev.type === 'error') prog.line(ev.error, 'error');
      });
      const ok = last && last.type === 'done' && last.results.every((r) => r.ok);
      prog.finish(ok, ok ? 'Fatto! Il primo avvio scarica il server e genera il mondo: segui l\'avanzamento dalla console.' : 'Operazione terminata con errori.');
    } catch (e) {
      prog.line(e.message, 'error');
      prog.finish(false, 'Operazione non riuscita.');
    }
    refreshServers();
    refreshMeta();
  }
}

function yamlPref() {
  try { return localStorage.getItem('mcm.showYaml') === '1'; } catch { return false; }
}

function withEnv(cfg, extra) {
  return { ...cfg, env: { ...extra, ...cfg.env } };
}

function yamlStr(v) { return JSON.stringify(String(v)); }

function toCompose(list) {
  const lines = ['services:'];
  for (const c of list) {
    lines.push(`  ${c.name || 'server'}:`);
    lines.push(`    image: itzg/minecraft-server:${c.imageTag}`);
    lines.push(`    container_name: ${c.name || 'server'}`);
    const ports = [`"${c.port}:25565"`];
    if (c.env.ENABLE_QUERY === 'TRUE') ports.push(`"${c.port}:${c.env.QUERY_PORT || 25565}/udp"`);
    if (c.exposeRcon && c.rconHostPort) ports.push(`"${c.rconHostPort}:${c.env.RCON_PORT || 25575}"`);
    for (const p of c.extraPorts) ports.push(`"${p.host}:${p.container}${p.proto === 'udp' ? '/udp' : ''}"`);
    lines.push('    ports:', ...ports.map((p) => `      - ${p}`));
    lines.push('    environment:', '      EULA: "TRUE"');
    for (const [k, v] of Object.entries(c.env)) lines.push(`      ${k}: ${yamlStr(v)}`);
    for (const e of c.customEnv) lines.push(`      ${e.key}: ${yamlStr(e.value)}`);
    lines.push('    volumes:', `      - ${c.dataPath || `./servers/${c.name}`}:/data`);
    lines.push(`    restart: ${c.restart}`);
    if (c.memoryLimit) lines.push(`    mem_limit: ${c.memoryLimit}`);
    if (c.cpus) lines.push(`    cpus: ${c.cpus}`);
    if (c.env.ENABLE_AUTOPAUSE === 'TRUE') lines.push('    cap_add:', '      - NET_RAW');
    lines.push('    tty: true', '    stdin_open: true');
  }
  return lines.join('\n') + '\n';
}

function progressModal(title) {
  const log = h('div', { class: 'progress-log mono' });
  const status = h('div', { class: 'progress-status' }, h('span', { class: 'spinner' }), h('span', {}, 'In corso…'));
  const closeBtn = btn('Chiudi', { kind: 'primary', disabled: true, onClick: () => m.close(true) });
  const m = openModal(h('div', { class: 'dialog' }, h('h2', {}, title), status, log, h('div', { class: 'modal-foot' }, closeBtn)), { cls: 'small', dismissible: false });
  return {
    line(msg, level) {
      log.append(h('div', { class: level === 'error' ? 'err' : '' }, msg));
      log.scrollTop = log.scrollHeight;
    },
    finish(ok, msg) {
      status.className = `progress-status ${ok ? 'ok' : 'bad'}`;
      status.replaceChildren(h('span', { class: 'status-ico' }, ok ? '✔' : '✖'), h('span', {}, msg));
      closeBtn.disabled = false;
      closeBtn.focus();
    },
  };
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

const QUICK_COMMANDS = [
  ['Giocatori', 'list'], ['Salva', 'save-all'], ['Giorno', 'time set day'], ['Notte', 'time set night'],
  ['Sereno', 'weather clear'], ['Pioggia', 'weather rain'], ['Whitelist', 'whitelist list'], ['TPS', 'tps'],
];

function openConsole(initial) {
  let s = initial;
  let es = null;
  let playersTimer = null;
  const history = [];
  let hIndex = -1;

  const logEl = h('div', { class: 'console-log mono', tabindex: '0' });
  const statusBadge = h('span', { class: 'badge' });
  const playersEl = h('div', { class: 'players' });
  const input = h('input', { class: 'input mono', placeholder: 'Comando (senza /), es. op Steve', autocomplete: 'off', spellcheck: 'false', onkeydown: onKey });
  const autoScroll = h('input', { type: 'checkbox', checked: true });
  const filterInput = h('input', { class: 'input small', type: 'search', placeholder: 'Filtra log…', oninput: applyFilter });

  function lineClass(text) {
    if (/\b(ERROR|SEVERE|FATAL)\b|Exception/.test(text)) return 'err';
    if (/\bWARN(ING)?\b/.test(text)) return 'warn';
    if (/Done \([\d.,]+s\)!|RCON running|Server started/.test(text)) return 'good';
    if (/joined the game|left the game|logged in/.test(text)) return 'player';
    if (/^\[init\]|^\[mc-image-helper\]/.test(text)) return 'init';
    return '';
  }

  function append(text, cls) {
    const near = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
    const el = h('div', { class: cls || lineClass(text) }, text);
    const q = filterInput.value.trim().toLowerCase();
    if (q && !text.toLowerCase().includes(q)) el.hidden = true;
    logEl.append(el);
    while (logEl.childElementCount > 4000) logEl.firstElementChild.remove();
    if (autoScroll.checked && near) logEl.scrollTop = logEl.scrollHeight;
  }

  function applyFilter() {
    const q = filterInput.value.trim().toLowerCase();
    for (const el of logEl.children) el.hidden = !!q && !el.textContent.toLowerCase().includes(q);
  }

  function connect() {
    if (es) es.close();
    logEl.replaceChildren();
    es = new EventSource(`/api/servers/${s.id}/logs?tail=800`);
    es.onmessage = (e) => append(JSON.parse(e.data));
    es.addEventListener('end', () => { es.close(); es = null; append('— flusso log terminato: il server è fermo —', 'sys'); });
    es.onerror = () => { if (es && es.readyState === EventSource.CLOSED) append('— connessione ai log persa —', 'sys'); };
    setTimeout(() => { logEl.scrollTop = logEl.scrollHeight; }, 300);
  }

  async function refreshInfo() {
    try { s = await api('GET', `/api/servers/${s.id}`); } catch { return; }
    const st = statusOf(s);
    statusBadge.className = `badge ${st.key}`;
    statusBadge.replaceChildren(h('i', { class: 'dot' }), st.label);
    if (!isRunning(s)) { playersEl.replaceChildren(h('span', { class: 'muted' }, 'Server fermo')); return; }
    if (!s.rconEnabled) { playersEl.replaceChildren(h('span', { class: 'muted' }, 'RCON disattivato: comandi non disponibili')); return; }
    try {
      const p = await api('GET', `/api/servers/${s.id}/players`);
      if (p.online === undefined) { playersEl.replaceChildren(h('span', { class: 'muted' }, s.health === 'starting' ? 'Server in avvio…' : 'Giocatori non disponibili')); return; }
      playersEl.replaceChildren(
        h('span', { class: 'players-count' }, icon('users'), `${p.online}/${p.max}`),
        ...(p.names.length ? p.names.map((n) => h('span', { class: 'chip player' }, n)) : [h('span', { class: 'muted' }, 'Nessuno online')]));
    } catch {
      playersEl.replaceChildren(h('span', { class: 'muted' }, 'Server in avvio…'));
    }
  }

  async function send(cmd) {
    cmd = cmd.trim();
    if (!cmd) return;
    history.unshift(cmd);
    hIndex = -1;
    append(`> ${cmd}`, 'cmd');
    try {
      const r = await api('POST', `/api/servers/${s.id}/command`, { command: cmd });
      if (r.output) r.output.split('\n').forEach((l) => append(l, r.exitCode ? 'err' : 'cmd-out'));
      else append(r.exitCode ? 'Comando fallito (RCON non pronto?)' : '(nessun output)', r.exitCode ? 'err' : 'cmd-out');
      if (/^(op|deop|kick|ban|pardon|whitelist)\b/.test(cmd)) refreshInfo();
    } catch (e) { append(e.message, 'err'); }
  }

  function onKey(e) {
    if (e.key === 'Enter') { send(input.value); input.value = ''; }
    else if (e.key === 'ArrowUp') { if (hIndex < history.length - 1) { hIndex++; input.value = history[hIndex]; } e.preventDefault(); }
    else if (e.key === 'ArrowDown') { if (hIndex > 0) { hIndex--; input.value = history[hIndex]; } else { hIndex = -1; input.value = ''; } e.preventDefault(); }
  }

  const m = openModal(h('div', { class: 'console' },
    h('header', { class: 'console-head' },
      h('div', { class: 'console-title' }, icon('terminal'), h('h2', {}, s.name), statusBadge),
      h('div', { class: 'row' },
        btn('Riconnetti', { icon: 'restart', kind: 'small', onClick: () => { connect(); refreshInfo(); } }),
        btn('', { icon: 'x', kind: 'icon-only ghost', title: 'Chiudi', onClick: () => m.close() }))),
    playersEl,
    h('div', { class: 'console-tools' }, filterInput, h('label', { class: 'inline-check' }, autoScroll, 'Scorrimento automatico'),
      h('span', { class: 'spacer' }), h('span', { class: 'muted small-text' }, 'Comandi via RCON')),
    logEl,
    h('div', { class: 'quick' }, QUICK_COMMANDS.map(([label, cmd]) => h('button', { type: 'button', class: 'chip button', title: cmd, onclick: () => send(cmd) }, label))),
    h('div', { class: 'console-input' }, h('span', { class: 'prompt mono' }, '>'), input, btn('Invia', { icon: 'send', kind: 'primary', onClick: () => { send(input.value); input.value = ''; input.focus(); } }))),
  { cls: 'console-modal', onClose: () => { if (es) es.close(); clearInterval(playersTimer); } });

  connect();
  refreshInfo();
  playersTimer = setInterval(async () => {
    const wasRunning = isRunning(s);
    await refreshInfo();
    if (!wasRunning && isRunning(s) && !es) connect();
  }, 8000);
  setTimeout(() => input.focus(), 50);
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

const CUBE_SVG = `<svg viewBox="0 0 64 64" fill="none"><path d="M32 4 58 18v28L32 60 6 46V18Z" fill="var(--grass-side)"/><path d="M32 4 58 18 32 32 6 18Z" fill="var(--grass-top)"/><path d="M32 32v28L6 46V18Z" fill="var(--dirt-dark)"/><path d="M32 32 58 18v28L32 60Z" fill="var(--dirt)"/><path d="M6 18l26 14 26-14v6L32 38 6 24Z" fill="var(--grass-side)"/></svg>`;

function init() {
  $('#brand-mark').innerHTML = CUBE_SVG;
  $('#new-server').replaceChildren(icon('plus'), h('span', {}, 'Nuovo server'));
  $('#new-server').onclick = () => openEditor({ mode: 'create' });
  $('#search-ico').replaceWith(icon('search'));
  $('#search').oninput = (e) => { state.search = e.target.value; renderDashboard(); };
  $('#select-all').onchange = (e) => {
    for (const s of filteredServers()) e.target.checked ? state.selected.add(s.id) : state.selected.delete(s.id);
    renderDashboard();
  };
  document.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => {
      state.filter = b.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderDashboard();
    };
  });
  const bulkIcons = { start: 'play', stop: 'stop', restart: 'restart', delete: 'trash' };
  document.querySelectorAll('[data-bulk]').forEach((b) => {
    b.prepend(icon(bulkIcons[b.dataset.bulk]));
    b.onclick = () => runBulk(b.dataset.bulk);
  });

  renderDashboard();
  refreshMeta().then(refreshServers).then(refreshStats);
  setInterval(refreshServers, 4000);
  setInterval(refreshStats, 6000);
  setInterval(refreshMeta, 15000);
}

init();
