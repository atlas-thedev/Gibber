/* Minimal end-to-end demo: create sandbox -> write a Vite app -> install -> dev server. */
const { io } = require('socket.io-client');

const API = process.env.API || 'http://localhost:3000';
const KEY = process.env.API_KEY || '';
const h = { 'Content-Type': 'application/json', ...(KEY ? { 'x-api-key': KEY } : {}) };
const post = (p, b) => fetch(API + p, { method: 'POST', headers: h, body: JSON.stringify(b || {}) }).then((r) => r.json());

(async () => {
  const sb = await post('/api/sandboxes', { exposedPorts: [5173] });
  console.log('sandbox', sb.id, sb.ports);

  await post(`/api/sandboxes/${sb.id}/fs/tree`, {
    tree: {
      'package.json': JSON.stringify(
        { name: 'demo', scripts: { dev: 'vite --host 0.0.0.0 --port 5173' }, devDependencies: { vite: '^5.0.0' } },
        null, 2
      ),
      'index.html': '<!doctype html><html><body><div id="app">hello</div><script type="module" src="/main.js"></script></body></html>',
      'main.js': "document.querySelector('#app').textContent = 'Hello from Gibber';"
    }
  });

  const socket = io(API, { auth: { apiKey: KEY } });
  socket.on('connect', () => socket.emit('attach', { sandboxId: sb.id }));
  socket.on('ready', () => socket.emit('run', { cmd: 'npm install && npm run dev' }));
  socket.on('output', ({ data }) => process.stdout.write(data));
  socket.on('exit', ({ code }) => console.log('\nexited', code));
  socket.on('error', (e) => console.error('ERR', e));
})();
