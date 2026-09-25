'use strict';
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./config');
const log = require('./utils/logger');
const docker = require('./services/dockerService');
const auth = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');
const sandboxRoutes = require('./routes/sandboxes');
const fileRoutes = require('./routes/files');
const registerTerminalHandlers = require('./ws/terminalHandler');

async function main() {
  const app = express();
  app.use(express.json({ limit: '25mb' })); // large enough for a whole project tree
  app.disable('x-powered-by');

  app.get('/health', (_req, res) =>
    res.json({ ok: true, sandboxes: docker.sandboxes.size, uptime: process.uptime() })
  );

  app.use('/api/sandboxes/:id/fs', auth, fileRoutes);
  app.use('/api/sandboxes', auth, sandboxRoutes);
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
  app.use(errorHandler);

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || '*' } });
  registerTerminalHandlers(io);

  await docker.init(); // ping daemon, create internal network, reap orphans, start GC

  server.listen(config.port, config.bindHost, () =>
    log.info(`Gibber listening on ${config.bindHost}:${config.port}`)
  );

  /* ---------------- zombie protection ----------------
   * Any exit path removes every container we created. Without this a crash
   * leaves 512MB containers pinned forever on the VPS.
   * Note: SIGKILL (kill -9) cannot be trapped — that case is covered by the
   * reapOrphans() label sweep on the next boot.
   */
  let closing = false;
  const shutdown = async (signal, err) => {
    if (closing) return;
    closing = true;
    if (err) log.error(`Fatal (${signal}):`, err.stack || err.message);
    else log.warn(`Received ${signal}, shutting down…`);
    const force = setTimeout(() => process.exit(1), 15000).unref();
    try {
      io.close();
      server.close();
      await docker.shutdown();
    } finally {
      clearTimeout(force);
      process.exit(err ? 1 : 0);
    }
  };

  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((s) => process.on(s, () => shutdown(s)));
  process.on('uncaughtException', (e) => shutdown('uncaughtException', e));
  process.on('unhandledRejection', (e) => shutdown('unhandledRejection', e));
}

main().catch((err) => {
  log.error('Startup failed:', err.message);
  process.exit(1);
});
