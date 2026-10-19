'use strict';
// Finto Docker Engine API su socket unix: implementa solo gli endpoint usati dal manager,
// così i test girano in CI senza un vero Docker.

const http = require('http');
const fs = require('fs');

function startFakeDocker(socketPath, { memTotal = 6 * 1024 ** 3 } = {}) {
  try { fs.unlinkSync(socketPath); } catch { /* non esiste */ }
  let seq = 0;
  const containers = new Map();
  const execs = [];

  const find = (ref) => {
    ref = decodeURIComponent(ref);
    for (const c of containers.values()) if (c.Id === ref || c.Name === `/${ref}`) return c;
    return null;
  };
  const add = (name, env, labels, status, hostConfig) => {
    const id = (++seq).toString(16).padStart(12, '0');
    containers.set(id, { Id: id, Name: `/${name}`, Env: env, Labels: labels || {}, status, HostConfig: hostConfig || { PortBindings: {} } });
    return id;
  };
  const inspect = (c) => ({
    Id: c.Id, Name: c.Name, Image: 'sha256:fake', RestartCount: 0,
    State: { Status: c.status, StartedAt: new Date().toISOString(), ExitCode: 0 },
    Config: { Env: c.Env, Labels: c.Labels, Image: 'itzg/minecraft-server:latest', Tty: true },
    HostConfig: c.HostConfig, Mounts: [],
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://docker');
      const p = u.pathname;
      const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      let m;
      if (p === '/version') return json(200, { Version: 'fake' });
      if (p === '/info') return json(200, { OperatingSystem: 'Fake', NCPU: 4, MemTotal: memTotal, Name: 'fake' });
      if (p === '/images/json') return json(200, []);
      if (/^\/images\/.+\/json$/.test(p)) return json(200, { Config: { Env: [] } });
      if (p === '/containers/json') return json(200, [...containers.values()].map((c) => ({ Id: c.Id, Image: 'itzg/minecraft-server:latest', Labels: c.Labels })));
      if (p === '/containers/create') {
        const spec = JSON.parse(body);
        const name = u.searchParams.get('name');
        if (find(name)) return json(409, { message: `Conflict: ${name}` });
        return json(201, { Id: add(name, spec.Env, spec.Labels, 'created', spec.HostConfig) });
      }
      if ((m = p.match(/^\/containers\/([^/]+)\/(json|start|stop|restart|rename|exec)$/))) {
        const c = find(m[1]);
        if (!c) return json(404, { message: 'No such container' });
        switch (m[2]) {
          case 'json': return json(200, inspect(c));
          case 'start': case 'restart': c.status = 'running'; return json(204, {});
          case 'stop': c.status = 'exited'; return json(204, {});
          case 'rename': c.Name = `/${u.searchParams.get('name')}`; return json(204, {});
          case 'exec': execs.push({ name: c.Name.slice(1), cmd: JSON.parse(body).Cmd }); return json(201, { Id: `ex${execs.length}` });
          default: break;
        }
      }
      if ((m = p.match(/^\/containers\/([^/]+)$/)) && req.method === 'DELETE') {
        const c = find(m[1]);
        if (c) containers.delete(c.Id);
        return json(204, {});
      }
      if (/^\/exec\/[^/]+\/start$/.test(p)) { res.writeHead(200); return res.end(''); }
      if (/^\/exec\/[^/]+\/json$/.test(p)) return json(200, { ExitCode: 0 });
      return json(404, { message: `Non implementato: ${req.method} ${p}` });
    });
  });

  return new Promise((resolve) => server.listen(socketPath, () => resolve({
    server,
    execs,
    addExternal: (name, env) => add(name, env, {}, 'running'),
    close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { startFakeDocker };
