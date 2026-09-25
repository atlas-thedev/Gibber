# Gibber — Cloud Sandbox Manager

Production-grade backend for running **AI-generated code** inside disposable Docker containers — an E2B / CodeSandbox / Replit style sandbox service in ~1k lines of Node.js.

Built for a **16 GB VPS**: every sandbox is capped at 512 MB RAM / 0.5 vCPU, runs unprivileged with no internet egress, and is automatically destroyed after 15 minutes of inactivity.

```
Client (editor / AI agent)
   │  REST  ──────────►  Express  ──►  dockerode  ──►  Docker Engine
   │  WS    ──────────►  socket.io ──►  container exec (stdout/stderr stream)
   └── http://127.0.0.1:41xxx  ◄── dynamic host port → container :5173
```

## Features

| # | Capability | Where |
|---|---|---|
| 1 | Container lifecycle, 512 MB / 0.5 CPU, non-root, `cap_drop ALL`, `no-new-privileges`, read-only rootfs, PID limit, internal (egress-less) network, dynamic host port mapping | `src/services/dockerService.js`, `src/services/portManager.js` |
| 2 | Activity tracker + TTL garbage collector (15 min idle → stop & remove) | `dockerService.touch()` / `startGarbageCollector()` |
| 3 | Bi-directional file I/O via tar streams — single file, batch, or whole directory tree from JSON, **without restarting the container** | `src/routes/files.js` |
| 4 | Live command execution over WebSockets with real-time `stdout`/`stderr`, stdin, pty resize, Ctrl-C, long-running dev servers | `src/ws/terminalHandler.js` |
| 5 | Zombie prevention (signal handlers + label sweep on boot), graceful port-exhaustion and port-conflict handling | `src/index.js`, `portManager.js` |

## Project structure

```
src/
├── index.js                  # express + socket.io bootstrap, graceful shutdown
├── config.js                 # env-driven configuration
├── middleware/
│   ├── auth.js               # optional x-api-key guard
│   └── errorHandler.js       # typed errors -> JSON
├── routes/
│   ├── sandboxes.js          # lifecycle, exec, stats, heartbeat
│   └── files.js              # readFile / writeFile / batch / tree / list / delete
├── services/
│   ├── dockerService.js      # all dockerode logic + TTL GC
│   └── portManager.js        # race-free dynamic host-port allocation
├── ws/terminalHandler.js     # streaming terminal sessions
└── utils/                    # logger, typed errors, path sanitising
docker/Dockerfile             # node:18-alpine + vite, non-root sandbox user
examples/client.js            # end-to-end demo
```

## Quick start

```bash
git clone https://github.com/atlas-thedev/Gibber.git
cd Gibber
npm install
cp .env.example .env

# 1. build the sandbox image (once)
npm run build:image          # -> node18-alpine-vite:latest

# 2. run the manager (needs access to /var/run/docker.sock)
npm start
```

Requirements: Node 18+, Docker Engine 24+, Linux. The user running Gibber must be in the `docker` group.

## Configuration (`.env`)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | API port |
| `BIND_HOST` | `127.0.0.1` | loopback by default; put nginx/Caddy in front |
| `SANDBOX_IMAGE` | `node18-alpine-vite:latest` | pre-built image |
| `SANDBOX_MEMORY_MB` | `512` | hard RAM cap (swap disabled) |
| `SANDBOX_CPUS` | `0.5` | CPU quota over a 100 ms period |
| `SANDBOX_NETWORK` | `sandbox_net` | internal bridge (no internet); use `none` to air-gap fully |
| `SANDBOX_TTL_MS` | `900000` | 15 min idle TTL |
| `GC_INTERVAL_MS` | `30000` | reaper sweep interval |
| `MAX_SANDBOXES` | `20` | 20 × 512 MB ≈ 10 GB, leaves headroom on a 16 GB box |
| `PORT_RANGE_START/END` | `41000` / `41999` | dynamic host ports |
| `API_KEY` | *(empty)* | when set, required as `x-api-key` on REST **and** socket handshake |

> **npm install inside a sandbox needs the registry.** With the default internal network there is no egress. Either attach a registry proxy (Verdaccio/Nexus) to `sandbox_net`, bake dependencies into the image, or set `SANDBOX_NETWORK=bridge` if you accept the risk.

## REST API

All routes are prefixed with `/api/sandboxes`.

### Lifecycle

```bash
# create
curl -XPOST localhost:3000/api/sandboxes -H 'content-type: application/json' \
  -d '{"exposedPorts":[5173],"env":{"NODE_ENV":"development"}}'
# → { "id":"…", "ports":[{"container":5173,"host":41000,"url":"http://127.0.0.1:41000"}], … }

GET    /api/sandboxes             # list + idleMs + expiresInMs
GET    /api/sandboxes/:id
GET    /api/sandboxes/:id/stats   # live CPU % and memory
POST   /api/sandboxes/:id/heartbeat
DELETE /api/sandboxes/:id
```

### One-shot command

```bash
curl -XPOST localhost:3000/api/sandboxes/$ID/exec \
  -H 'content-type: application/json' -d '{"cmd":"node -v"}'
# → { "exitCode":0, "stdout":"v18.20.4\n", "stderr":"" }
```

### File system (no restart)

```bash
# write one file
curl -XPUT localhost:3000/api/sandboxes/$ID/fs/file \
  -H 'content-type: application/json' \
  -d '{"path":"src/App.jsx","content":"export default () => <h1>hi</h1>"}'

# write a whole tree from JSON
curl -XPOST localhost:3000/api/sandboxes/$ID/fs/tree \
  -H 'content-type: application/json' \
  -d '{"tree":{"package.json":"{}","src":{"main.js":"console.log(1)"}}}'

# batch (explicit paths, supports base64 for binaries)
curl -XPOST localhost:3000/api/sandboxes/$ID/fs/batch \
  -d '{"files":[{"path":"a.txt","content":"aGk=","encoding":"base64"}]}'

curl "localhost:3000/api/sandboxes/$ID/fs/file?path=src/App.jsx"
curl "localhost:3000/api/sandboxes/$ID/fs/list?path=."
curl -XDELETE "localhost:3000/api/sandboxes/$ID/fs/file?path=src/old.js"
```

## WebSocket terminal

```js
const socket = io('http://localhost:3000', { auth: { apiKey: API_KEY } });

socket.emit('attach', { sandboxId });
socket.on('ready', () => socket.emit('run', { cmd: 'npm install && npm run dev' }));

socket.on('output', ({ data }) => term.write(data));   // real-time stdout/stderr
socket.on('exit',   ({ code }) => console.log('exit', code));

socket.emit('stdin',  { data: '\u0003' });             // Ctrl-C
socket.emit('resize', { cols: 120, rows: 30 });        // xterm.js pty resize
socket.emit('kill');
```

| Event | Direction | Payload |
|---|---|---|
| `attach` | → | `{ sandboxId }` |
| `ready` | ← | `{ sandboxId, ports, workdir }` |
| `run` | → | `{ cmd, cwd?, env? }` |
| `output` | ← | `{ stream, data }` |
| `stdin` / `resize` / `kill` | → | `{ data }` / `{ cols, rows }` / `—` |
| `exit` | ← | `{ code }` |
| `error` | ← | `{ message }` |

Run the full demo: `node examples/client.js`

## The tricky parts, explained

**Docker stream multiplexing.** With `Tty: false` the daemon interleaves stdout and stderr in one stream, each frame prefixed by an 8-byte header. Reading it raw gives binary noise. `container.modem.demuxStream(stream, out, err)` splits it (`execCollect`). With `Tty: true` you get one clean merged stream — what xterm.js wants — which is why the terminal handler uses TTY mode and the buffered API does not.

**Long-running processes.** `exec.start()` resolves as soon as the stream is attached, not when the process ends. `npm run dev` therefore never blocks the API: the socket keeps emitting `output` and `exit` only fires if the process actually dies. Never `await` a dev server.

**Killing an exec.** Docker has no "kill exec" endpoint. We `exec.inspect()` to read the real `Pid`, then run `kill -TERM <pid>` as a second exec inside the container. Destroying the hijacked stream alone would detach us and leave the process burning CPU.

**Archive API vs. mounts.** `getArchive` / `docker cp` cannot see inside a **tmpfs** mount and `putArchive` is refused outright when `ReadonlyRootfs` is set — both fail in ways that look like a missing file. Gibber therefore mounts the workdir as an anonymous **volume** (also keeping `node_modules` out of the 512 MB memory cgroup) and falls back to streaming tar through `exec` on both the write and read path.

**File I/O without restart.** `putArchive` / `getArchive` take and return **tar** streams. Writes build one in-memory tar with `tar-stream` (including explicit directory entries, because busybox tar will not create parents), so an entire project is one API call. Reads must unpack the returned tar even for a single file, with a size cap so a huge file cannot OOM the manager.

**Auto-kill (TTL).** Every write, exec, stdin frame and socket heartbeat calls `touch(id)`. A sweeper (`setInterval(...).unref()`) removes anything idle for `SANDBOX_TTL_MS`. An attached terminal touches its sandbox every 60 s so a watched dev server is not reaped mid-session.

**Zombie containers.** Three layers: (1) `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException`/`unhandledRejection` all funnel into `docker.shutdown()` which force-removes every sandbox; (2) on boot, `reapOrphans()` deletes anything carrying the `gibber.owner` label — this covers `kill -9`, which cannot be trapped; (3) `RestartPolicy: no` so Docker never resurrects a reaped sandbox.

**Port exhaustion & conflicts.** `PortManager` reserves a port in memory *before* probing it with a real `bind()`, so two parallel creates can never pick the same port and ports used by non-Docker processes are skipped. A full range returns `503 CAPACITY_EXHAUSTED`; a late Docker collision returns `409 PORT_CONFLICT`. Failed creates always release their reservations.

## Security model

- non-root `sandbox` user (uid 1000), `CapDrop: ALL`, `no-new-privileges`
- read-only rootfs; only `/tmp` (64 MB tmpfs, `noexec`) and the workdir volume are writable
- memory + swap capped at 512 MB, CPU quota 0.5, `PidsLimit` 128 (fork-bomb protection), `nofile` ulimit
- `Internal: true` network → no outbound internet from sandboxes
- host ports bound to `127.0.0.1` only — put your reverse proxy in front for public preview URLs
- the API itself binds `127.0.0.1` by default so it cannot be reached around the proxy
- path traversal blocked on every file operation
- optional `x-api-key` on REST and socket handshake

Not included (add before exposing to untrusted users at scale): gVisor/Kata runtime, per-user quotas, seccomp profile tuning, audit logging.

## Capacity on 16 GB

| | |
|---|---|
| Per sandbox | 512 MB RAM, 0.5 vCPU |
| `MAX_SANDBOXES=20` | ~10 GB, ~6 GB left for host + manager |
| Idle reclaim | 15 min TTL, swept every 30 s |

Raise `MAX_SANDBOXES` only if your workloads are mostly idle; Docker does not overcommit CPU quota, but memory is reserved only when used.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `connect EACCES /var/run/docker.sock` | `sudo usermod -aG docker $USER` then re-login |
| `IMAGE_NOT_FOUND` | `npm run build:image` |
| `npm install` hangs in a sandbox | internal network has no egress — see the note above |
| `npm install` fails with `ENOSPC` | the npm cache must be on its own volume, not `/tmp` (64 MB tmpfs) |
| `CAPACITY_EXHAUSTED` | widen `PORT_RANGE_*` or raise `MAX_SANDBOXES` |
| Containers survive a crash | they are reaped on next boot by label; check `docker ps -a --filter label=gibber.owner` |

## License

MIT
