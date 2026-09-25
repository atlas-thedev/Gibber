'use strict';
const os = require('os');
const crypto = require('crypto');
const Docker = require('dockerode');
const tar = require('tar-stream');
const config = require('../config');
const log = require('../utils/logger');
const { AppError, NotFound, BadRequest, Exhausted } = require('../utils/errors');
const { resolveSandboxPath } = require('../utils/paths');
const PortManager = require('./portManager');

const LABEL_OWNER = 'gibber.owner';
const LABEL_HOST = 'gibber.host';
const OWNER_VALUE = 'gibber-sandbox-manager';

/** Collect a readable stream into a Buffer (used for tar payloads + short execs). */
const collect = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

class DockerService {
  constructor(opts = {}) {
    this.docker = new Docker(opts.dockerOptions || { socketPath: '/var/run/docker.sock' });
    this.cfg = config.sandbox;
    this.ports = new PortManager(config.ports);
    /** @type {Map<string, {id:string,containerId:string,image:string,ports:object[],createdAt:number,lastActivity:number,status:string}>} */
    this.sandboxes = new Map();
    this.gcTimer = null;
  }

  /* ------------------------------------------------------------------ *
   * Bootstrap
   * ------------------------------------------------------------------ */

  async init() {
    await this.docker.ping();
    await this.ensureNetwork();
    // Adopt or destroy containers left over from a previous crash (zombie sweep).
    await this.reapOrphans();
    this.startGarbageCollector();
    log.info('DockerService ready');
  }

  /**
   * Internal network with `internal: true` => containers can talk to each other
   * (and to a proxy you attach) but have NO route to the internet. Set
   * SANDBOX_NETWORK=none for a fully air-gapped sandbox.
   */
  async ensureNetwork() {
    if (this.cfg.network === 'none' || this.cfg.network === 'host') return;
    const nets = await this.docker.listNetworks({ filters: { name: [this.cfg.network] } });
    if (nets.some((n) => n.Name === this.cfg.network)) return;
    await this.docker.createNetwork({
      Name: this.cfg.network,
      Driver: 'bridge',
      Internal: true, // <- the actual egress block
      Labels: { [LABEL_OWNER]: OWNER_VALUE }
    });
    log.info(`Created internal network ${this.cfg.network}`);
  }

  /**
   * Zombie protection, part 1: anything labelled by *this host* from a previous
   * process is gone from our in-memory registry, so remove it on boot.
   */
  async reapOrphans() {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_OWNER}=${OWNER_VALUE}`] }
    });
    await Promise.all(
      list.map(async (info) => {
        try {
          await this.docker.getContainer(info.Id).remove({ force: true, v: true });
          log.warn(`Reaped orphan container ${info.Id.slice(0, 12)}`);
        } catch (err) {
          log.error('Failed to reap orphan', info.Id, err.message);
        }
      })
    );
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  /**
   * @param {{image?:string, exposedPorts?:number[], env?:object, cmd?:string[]}} opts
   */
  async createSandbox(opts = {}) {
    if (this.sandboxes.size >= this.cfg.maxSandboxes) {
      throw Exhausted(`Sandbox limit reached (${this.cfg.maxSandboxes}). Try again shortly.`);
    }

    const image = opts.image || this.cfg.image;
    const exposed = (opts.exposedPorts && opts.exposedPorts.length ? opts.exposedPorts : [5173])
      .map(Number)
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    if (!exposed.length) throw BadRequest('exposedPorts must be valid TCP port numbers');

    const id = crypto.randomUUID();
    const hostPorts = await this.ports.acquire(exposed.length); // may throw 503

    // Docker port maps: { "5173/tcp": {} } and { "5173/tcp": [{ HostPort: "41000" }] }
    const ExposedPorts = {};
    const PortBindings = {};
    exposed.forEach((p, i) => {
      ExposedPorts[`${p}/tcp`] = {};
      PortBindings[`${p}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: String(hostPorts[i]) }];
    });

    let container;
    try {
      container = await this.docker.createContainer({
        name: `gibber-${id.slice(0, 8)}`,
        Image: image,
        // Keep PID 1 alive so exec sessions have something to attach to.
        Cmd: opts.cmd || ['tail', '-f', '/dev/null'],
        Tty: false,
        User: this.cfg.user, // non-root
        WorkingDir: this.cfg.workdir,
        Env: Object.entries(opts.env || {}).map(([k, v]) => `${k}=${v}`),
        ExposedPorts,
        Labels: { [LABEL_OWNER]: OWNER_VALUE, [LABEL_HOST]: os.hostname(), 'gibber.id': id },
        HostConfig: {
          PortBindings,
          Memory: this.cfg.memoryMb * 1024 * 1024,
          MemorySwap: this.cfg.memoryMb * 1024 * 1024, // == Memory -> swap disabled
          MemorySwappiness: 0,
          // CPU quota is expressed against a 100ms period: 0.5 CPU => 50000/100000
          CpuPeriod: 100000,
          CpuQuota: Math.round(this.cfg.cpus * 100000),
          PidsLimit: this.cfg.pidsLimit, // fork-bomb protection
          NetworkMode: this.cfg.network,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          ReadonlyRootfs: true, // only the writable mounts below can be touched
          // /tmp is RAM-backed and tiny. The workdir is an ANONYMOUS VOLUME, not a
          // tmpfs, for two reasons:
          //   1. Docker's archive API (getArchive / `docker cp`) cannot see inside a
          //      tmpfs mount — reads would 404 on files that plainly exist.
          //   2. tmpfs pages count against the container's memory cgroup, so a
          //      300MB node_modules would eat most of the 512MB budget.
          // `remove({ v: true })` disposes of the volume with the container.
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
          Mounts: [
            { Type: 'volume', Target: this.cfg.workdir, ReadOnly: false },
            // Separate volume for the npm cache: it must not sit on the small
            // /tmp tmpfs (ENOSPC on the first real `npm install`) and it should
            // not pollute the user's workspace.
            { Type: 'volume', Target: '/home/sandbox/.cache', ReadOnly: false }
          ],
          Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 2048 }],
          RestartPolicy: { Name: 'no' }, // never resurrect a reaped sandbox
          AutoRemove: false // we remove explicitly so we can read exit info first
        }
      });
      await container.start();
    } catch (err) {
      hostPorts.forEach((p) => this.ports.release(p)); // no leaked reservations
      if (container) await container.remove({ force: true }).catch(() => {});
      if (err.statusCode === 404) {
        throw new AppError(`Image "${image}" not found. Build it first.`, 400, 'IMAGE_NOT_FOUND');
      }
      if (String(err.message).includes('port is already allocated')) {
        throw new AppError('Host port conflict, retry.', 409, 'PORT_CONFLICT');
      }
      throw err;
    }

    const record = {
      id,
      containerId: container.id,
      name: `gibber-${id.slice(0, 8)}`,
      image,
      ports: exposed.map((p, i) => ({
        container: p,
        host: hostPorts[i],
        url: `http://127.0.0.1:${hostPorts[i]}`
      })),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: 'running'
    };
    this.sandboxes.set(id, record);
    log.info(`Sandbox ${id} started (${record.ports.map((p) => p.host).join(',')})`);
    return record;
  }

  get(id) {
    const s = this.sandboxes.get(id);
    if (!s) throw NotFound(`Sandbox ${id} not found (it may have been garbage collected)`);
    return s;
  }

  list() {
    return [...this.sandboxes.values()].map((s) => ({
      ...s,
      idleMs: Date.now() - s.lastActivity,
      expiresInMs: Math.max(0, this.cfg.ttlMs - (Date.now() - s.lastActivity))
    }));
  }

  /** Every file write / command / socket frame must call this to postpone the reaper. */
  touch(id) {
    const s = this.sandboxes.get(id);
    if (s) s.lastActivity = Date.now();
    return s;
  }

  async destroySandbox(id, reason = 'manual') {
    const s = this.sandboxes.get(id);
    if (!s) return false;
    this.sandboxes.delete(id); // delete first: GC + parallel deletes become no-ops
    try {
      const c = this.docker.getContainer(s.containerId);
      await c.remove({ force: true, v: true }); // force => SIGKILL then rm, volumes too
    } catch (err) {
      if (err.statusCode !== 404) log.error(`destroy ${id}:`, err.message);
    } finally {
      s.ports.forEach((p) => this.ports.release(p.host));
    }
    log.info(`Sandbox ${id} destroyed (${reason})`);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Auto garbage collection (TTL)
   * ------------------------------------------------------------------ */

  startGarbageCollector() {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => {
      const now = Date.now();
      for (const s of [...this.sandboxes.values()]) {
        if (now - s.lastActivity >= this.cfg.ttlMs) {
          this.destroySandbox(s.id, `idle > ${Math.round(this.cfg.ttlMs / 60000)}m`).catch((e) =>
            log.error('GC failure', e.message)
          );
        }
      }
    }, this.cfg.gcIntervalMs);
    // Do not keep the event loop alive just for the sweeper.
    this.gcTimer.unref();
    log.info(`GC every ${this.cfg.gcIntervalMs}ms, TTL ${this.cfg.ttlMs}ms`);
  }

  /** Called from SIGINT/SIGTERM/uncaught handlers: zombie protection, part 2. */
  async shutdown() {
    clearInterval(this.gcTimer);
    this.gcTimer = null;
    const ids = [...this.sandboxes.keys()];
    log.warn(`Shutting down, removing ${ids.length} sandbox(es)…`);
    await Promise.allSettled(ids.map((id) => this.destroySandbox(id, 'shutdown')));
  }

  /* ------------------------------------------------------------------ *
   * File I/O — tar streams (no restart, no bind mounts)
   * ------------------------------------------------------------------ */

  /**
   * writeFiles: build ONE tar archive in memory and hand it to putArchive.
   * Docker extracts it relative to `path`, creating intermediate dirs, so an
   * entire project tree is a single API call — far cheaper than N execs.
   */
  async writeFiles(id, files) {
    const s = this.get(id);
    if (!Array.isArray(files) || !files.length) throw BadRequest('files[] is required');

    const pack = tar.pack();
    const dirs = new Set();

    for (const f of files) {
      const abs = resolveSandboxPath(this.cfg.workdir, f.path);
      const rel = abs.slice(this.cfg.workdir.length + 1); // tar entries must be relative
      if (!rel) throw BadRequest(`refusing to write to the workdir root: ${f.path}`);

      // Emit parent directories explicitly; some images ship a busybox tar that
      // will not auto-create them.
      const parts = rel.split('/').slice(0, -1);
      let acc = '';
      for (const p of parts) {
        acc += `${p}/`;
        if (!dirs.has(acc)) {
          dirs.add(acc);
          pack.entry({ name: acc, type: 'directory', mode: 0o755 });
        }
      }
      const content = Buffer.from(f.content ?? '', f.encoding === 'base64' ? 'base64' : 'utf8');
      pack.entry({ name: rel, mode: f.mode || 0o644, size: content.length }, content);
    }
    pack.finalize();

    await this.putArchive(s, pack);
    this.touch(id);
    return { written: files.length };
  }

  /**
   * Ship a tar stream into the container.
   *
   * Gotcha: the Docker daemon rejects `putArchive` with
   * "container rootfs is marked read-only" whenever ReadonlyRootfs is set —
   * even when the destination is a writable tmpfs mount, because the check is
   * on the container, not the target path. So we pipe the same tar into
   * `tar -xf -` through exec, which runs *inside* the container namespace and
   * therefore only has to satisfy normal filesystem permissions.
   * putArchive is still tried first: it is one API call and avoids spawning a
   * process when the rootfs is writable.
   */
  async putArchive(sandbox, pack) {
    const container = this.docker.getContainer(sandbox.containerId);
    const buf = await collect(pack); // buffer once so we can retry the same bytes

    try {
      await container.putArchive(buf, { path: this.cfg.workdir });
      return;
    } catch (err) {
      const readOnly = /read-only/i.test(err.message || '');
      if (!readOnly) throw err;
    }

    const exec = await container.exec({
      Cmd: ['tar', '-xf', '-', '-C', this.cfg.workdir],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: this.cfg.user,
      WorkingDir: this.cfg.workdir
    });
    const stream = await exec.start({ hijack: true, stdin: true });

    const errChunks = [];
    const sink = new (require('stream').Writable)({ write(_c, _e, cb) { cb(); } });
    const errSink = new (require('stream').Writable)({
      write(c, _e, cb) { errChunks.push(c); cb(); }
    });
    container.modem.demuxStream(stream, sink, errSink);

    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('close', resolve);
      stream.on('error', reject);
      stream.end(buf); // write the whole archive, then EOF so tar terminates
    });

    const info = await exec.inspect();
    if (info.ExitCode !== 0) {
      throw new AppError(
        `tar extract failed (exit ${info.ExitCode}): ${Buffer.concat(errChunks).toString().trim()}`,
        500,
        'WRITE_FAILED'
      );
    }
  }

  /** Flatten `{ "src/App.jsx": "…", "package.json": "…" }` into writeFiles input. */
  async writeTree(id, tree, base = '.') {
    const files = [];
    const walk = (node, prefix) => {
      for (const [key, value] of Object.entries(node)) {
        const p = `${prefix}/${key}`.replace(/^\.\//, '');
        if (value && typeof value === 'object' && !Buffer.isBuffer(value)) walk(value, p);
        else files.push({ path: p, content: String(value ?? '') });
      }
    };
    walk(tree, base);
    return this.writeFiles(id, files);
  }

  /**
   * readFile: getArchive returns a *tar stream* even for a single file, so we
   * have to unpack it. We also cap the size to avoid a 2GB file OOM-ing the API.
   */
  async readFile(id, filePath, { maxBytes = 5 * 1024 * 1024, encoding = 'utf8' } = {}) {
    const s = this.get(id);
    const abs = resolveSandboxPath(this.cfg.workdir, filePath);

    let stream;
    try {
      stream = await this.docker.getContainer(s.containerId).getArchive({ path: abs });
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      // The daemon reports 404 both for a genuinely missing file and for any
      // path the archive API cannot traverse (tmpfs mounts, some storage
      // drivers). Confirm from inside the container before giving up, and fall
      // back to streaming a tar out through exec.
      const probe = await this.execCollect(id, ['test', '-f', abs], { timeoutMs: 10_000 });
      if (probe.exitCode !== 0) throw NotFound(`No such file in sandbox: ${abs}`);
      return this.readFileViaExec(id, abs, { maxBytes, encoding });
    }

    const extract = tar.extract();
    const result = await new Promise((resolve, reject) => {
      let done = false;
      extract.on('entry', (header, entryStream, next) => {
        if (header.type === 'directory') {
          entryStream.resume();
          return next();
        }
        if (header.size > maxBytes) {
          entryStream.resume();
          reject(new AppError(`File larger than ${maxBytes} bytes`, 413, 'FILE_TOO_LARGE'));
          return next();
        }
        collect(entryStream).then((buf) => {
          done = true;
          resolve({ path: abs, size: header.size, content: buf.toString(encoding), encoding });
          next();
        }, reject);
      });
      extract.on('finish', () => !done && reject(NotFound(`Empty archive for ${abs}`)));
      extract.on('error', reject);
      stream.pipe(extract);
    });

    this.touch(id);
    return result;
  }

  /** Read a file by catting it through exec. Base64 keeps binary content intact. */
  async readFileViaExec(id, abs, { maxBytes, encoding }) {
    const out = await this.execCollect(id, ['sh', '-c', `base64 "${abs}"`], { timeoutMs: 30_000 });
    if (out.exitCode !== 0) throw NotFound(`Cannot read ${abs}: ${out.stderr.trim()}`);
    const buf = Buffer.from(out.stdout.replace(/\s+/g, ''), 'base64');
    if (buf.length > maxBytes) {
      throw new AppError(`File larger than ${maxBytes} bytes`, 413, 'FILE_TOO_LARGE');
    }
    return { path: abs, size: buf.length, content: buf.toString(encoding), encoding };
  }

  async listDir(id, dirPath = '.') {
    const abs = resolveSandboxPath(this.cfg.workdir, dirPath);
    const out = await this.execCollect(id, ['ls', '-la', abs]);
    if (out.exitCode !== 0) throw NotFound(`Cannot list ${abs}: ${out.stderr.trim()}`);
    return { path: abs, entries: out.stdout.trim().split('\n').slice(1) };
  }

  async deletePath(id, targetPath) {
    const abs = resolveSandboxPath(this.cfg.workdir, targetPath);
    const out = await this.execCollect(id, ['rm', '-rf', abs]);
    if (out.exitCode !== 0) throw new AppError(out.stderr || 'delete failed', 500, 'DELETE_FAILED');
    return { deleted: abs };
  }

  /* ------------------------------------------------------------------ *
   * Exec
   * ------------------------------------------------------------------ */

  /**
   * Short-lived command, buffered.
   *
   * Tricky part: with Tty:false Docker multiplexes stdout/stderr into ONE stream
   * using an 8-byte frame header. `modem.demuxStream` splits it back apart —
   * without it you get binary garbage in your output.
   */
  async execCollect(id, cmd, { timeoutMs = 60_000, cwd } = {}) {
    const s = this.get(id);
    const container = this.docker.getContainer(s.containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: this.cfg.user,
      WorkingDir: cwd ? resolveSandboxPath(this.cfg.workdir, cwd) : this.cfg.workdir
    });
    const stream = await exec.start({ hijack: true, stdin: false });

    const stdoutChunks = [];
    const stderrChunks = [];
    const outSink = new (require('stream').Writable)({
      write(c, _e, cb) { stdoutChunks.push(c); cb(); }
    });
    const errSink = new (require('stream').Writable)({
      write(c, _e, cb) { stderrChunks.push(c); cb(); }
    });
    container.modem.demuxStream(stream, outSink, errSink);

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        stream.destroy();
        reject(new AppError(`Command timed out after ${timeoutMs}ms`, 504, 'EXEC_TIMEOUT'));
      }, timeoutMs);
      stream.on('end', () => { clearTimeout(t); resolve(); });
      stream.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    const info = await exec.inspect();
    this.touch(id);
    return {
      exitCode: info.ExitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8')
    };
  }

  /**
   * Long-running command (npm run dev). Returns immediately with handles so the
   * caller can stream output and kill it later. NEVER await this in a route —
   * a dev server never exits and would hang the request forever.
   */
  async execStream(id, cmd, { cwd, tty = true, env = {} } = {}) {
    const s = this.get(id);
    const container = this.docker.getContainer(s.containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: tty, // TTY mode: one merged stream, real terminal behaviour (colours, ^C)
      User: this.cfg.user,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      WorkingDir: cwd ? resolveSandboxPath(this.cfg.workdir, cwd) : this.cfg.workdir
    });
    // hijack:true gives a raw duplex socket; we can write stdin into it.
    const stream = await exec.start({ hijack: true, stdin: true, Tty: tty });
    this.touch(id);
    return { exec, stream, container, tty };
  }

  /** Resize the pty so `vim`/`top` render correctly in xterm.js clients. */
  async resizeExec(exec, { cols, rows }) {
    try {
      await exec.resize({ w: cols, h: rows });
    } catch (_) { /* exec already finished */ }
  }

  async stats(id) {
    const s = this.get(id);
    const raw = await this.docker.getContainer(s.containerId).stats({ stream: false });
    const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
    const sysDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
    return {
      cpuPercent: sysDelta > 0 ? +((cpuDelta / sysDelta) * 100).toFixed(2) : 0,
      memoryMb: +(raw.memory_stats.usage / 1024 / 1024).toFixed(1),
      memoryLimitMb: +(raw.memory_stats.limit / 1024 / 1024).toFixed(1)
    };
  }
}

module.exports = new DockerService();
module.exports.DockerService = DockerService;
