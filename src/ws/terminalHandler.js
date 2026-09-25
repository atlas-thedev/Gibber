'use strict';
const config = require('../config');
const docker = require('../services/dockerService');
const log = require('../utils/logger');

/**
 * Socket protocol
 *  client -> server : attach {sandboxId}, run {cmd, cwd, env}, stdin {data},
 *                     resize {cols, rows}, kill {}
 *  server -> client : ready, output {stream,data}, exit {code}, error {message}
 */
module.exports = function registerTerminalHandlers(io) {
  if (config.apiKey) {
    io.use((socket, next) => {
      const key = socket.handshake.auth?.apiKey || socket.handshake.headers['x-api-key'];
      return key === config.apiKey ? next() : next(new Error('unauthorized'));
    });
  }

  io.on('connection', (socket) => {
    /** @type {{stream:any, exec:any}|null} live process for this socket */
    let session = null;
    let sandboxId = null;
    let idleTicker = null;

    const fail = (message) => socket.emit('error', { message });

    const cleanup = () => {
      clearInterval(idleTicker);
      if (session?.stream) {
        // Destroying the hijacked socket detaches us; the process inside the
        // container is killed separately (see killProcess) because Docker keeps
        // an exec running even after its stream is gone.
        session.stream.destroy();
      }
      session = null;
    };

    /**
     * Docker has no "kill exec" API. The reliable trick: look up the exec's PID
     * from the daemon and send it a signal from inside the container.
     */
    const killProcess = async (signal = 'TERM') => {
      if (!session || !sandboxId) return;
      try {
        const info = await session.exec.inspect();
        if (info.Running && info.Pid) {
          await docker.execCollect(sandboxId, ['kill', `-${signal}`, String(info.Pid)], {
            timeoutMs: 5000
          }).catch(() => {});
        }
      } catch (err) {
        log.debug('kill failed', err.message);
      } finally {
        cleanup();
      }
    };

    socket.on('attach', ({ sandboxId: id } = {}) => {
      try {
        const s = docker.get(id);
        sandboxId = s.id;
        socket.join(`sandbox:${s.id}`);
        // A connected terminal counts as activity, so the TTL reaper does not
        // kill a sandbox whose dev server is being watched.
        clearInterval(idleTicker);
        idleTicker = setInterval(() => docker.touch(sandboxId), 60_000);
        idleTicker.unref?.();
        socket.emit('ready', { sandboxId: s.id, ports: s.ports, workdir: config.sandbox.workdir });
      } catch (err) {
        fail(err.message);
      }
    });

    socket.on('run', async ({ cmd, cwd, env } = {}) => {
      if (!sandboxId) return fail('attach to a sandbox first');
      if (session) return fail('a process is already running on this socket');
      if (!cmd) return fail('cmd is required');

      try {
        const argv = Array.isArray(cmd) ? cmd : ['sh', '-lc', cmd];
        // TTY mode = single merged stream (no 8-byte multiplex header), which is
        // exactly what xterm.js expects. For a machine-readable split use
        // tty:false + modem.demuxStream as in execCollect().
        session = await docker.execStream(sandboxId, argv, { cwd, env, tty: true });

        session.stream.on('data', (chunk) => {
          docker.touch(sandboxId);
          socket.emit('output', { stream: 'stdout', data: chunk.toString('utf8') });
        });

        // 'end' fires when the process exits OR the container dies. Inspect to
        // get the real exit code; a dev server that is still running simply
        // never reaches this handler, so the HTTP API is never blocked.
        session.stream.on('end', async () => {
          let code = null;
          try { code = (await session.exec.inspect()).ExitCode; } catch (_) {}
          socket.emit('exit', { code });
          cleanup();
        });

        session.stream.on('error', (err) => {
          fail(`stream error: ${err.message}`);
          cleanup();
        });

        socket.emit('output', { stream: 'system', data: `$ ${Array.isArray(cmd) ? cmd.join(' ') : cmd}\r\n` });
      } catch (err) {
        fail(err.message);
        cleanup();
      }
    });

    socket.on('stdin', ({ data } = {}) => {
      if (!session) return;
      docker.touch(sandboxId);
      session.stream.write(data); // e.g. "\u0003" for Ctrl-C
    });

    socket.on('resize', ({ cols, rows } = {}) => {
      if (session && cols && rows) docker.resizeExec(session.exec, { cols, rows });
    });

    socket.on('kill', () => killProcess('TERM'));

    socket.on('disconnect', () => {
      // Detach the stream but keep the container alive: the user may reconnect.
      // The TTL reaper is the only thing that removes sandboxes.
      killProcess('TERM').catch(() => {});
    });
  });
};
