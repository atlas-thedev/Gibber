# Deploying Gibber

This is the exact setup running in production on a 6 vCPU / 12 GB Ubuntu 24.04 box
behind nginx and Cloudflare.

## 1. Install

```bash
git clone https://github.com/atlas-thedev/Gibber.git /opt/gibber
cd /opt/gibber
npm install --omit=dev
npm run build:image          # builds node18-alpine-vite:latest
cp .env.example .env         # then edit, at minimum set API_KEY
```

Generate a key with `openssl rand -hex 24`.

## 2. systemd

Copy [`deploy/gibber.service`](./gibber.service) to `/etc/systemd/system/`, then:

```bash
systemctl daemon-reload
systemctl enable --now gibber
journalctl -u gibber -f        # or tail -f /var/log/gibber.log
```

`TimeoutStopSec=30` matters: it gives the process time to force-remove every
sandbox on SIGTERM before systemd escalates to SIGKILL.

## 3. nginx

Copy [`deploy/nginx.conf`](./nginx.conf) to `/etc/nginx/sites-available/gibber.conf`,
symlink it into `sites-enabled`, adjust `server_name`, then
`nginx -t && systemctl reload nginx`. Issue TLS with
`certbot --nginx -d your.domain --redirect`.

It provides:

- `/` -> the API and the socket.io terminal, with `proxy_buffering off` and
  1-hour timeouts so a streamed `npm install` is never cut off
- `/preview/port/<41xxx>/` -> a sandbox's dev server, with the port range pinned
  in the regex so the proxy cannot be pointed at other host services

## Gotchas hit while deploying this

**nginx regex braces.** `location ~ ^/preview/port/(41[0-9]{3})/...` fails with
`pcre2_compile() failed: missing closing parenthesis` because nginx parses `{`
as a block delimiter. Quote the whole regex.

**Vite 5.4 allowedHosts.** A proxied dev server answers
`Blocked request. This host is not allowed.` The proxy sends
`proxy_set_header Host 127.0.0.1:$1;` so sandbox projects need no
proxy-specific vite config.

**Cloudflare error 525.** With the certbot-generated
`options-ssl-nginx.conf` cipher list, Cloudflare's origin handshake failed with
`SSL_do_handshake() failed (SSL: error:0A0000BA:SSL routines::bad cipher)` even
though the certificate was valid and the origin worked from a normal client.
Replacing the include with `ssl_protocols TLSv1.2 TLSv1.3;` and
`ssl_ciphers HIGH:!aNULL:!MD5;` fixed it. Diagnose this by setting
`error_log /var/log/nginx/error.log info;` — TLS handshake failures never appear
in the access log, so an "it never reaches my server" conclusion can be wrong.

**Bind address.** Set `BIND_HOST=127.0.0.1` (the default) so the API cannot be
reached around the proxy, and remember that published sandbox ports also bind to
loopback only.

## Capacity

| Setting | Value |
|---|---|
| `SANDBOX_MEMORY_MB` / `SANDBOX_CPUS` | 512 / 0.5 |
| `MAX_SANDBOXES` | 12 (~6 GB peak) |
| `SANDBOX_TTL_MS` | 900000 (15 min idle) |
| Port pool | 41000-41999 |

## Verifying a deployment

```bash
API=https://your.domain; KEY=...
curl $API/health
ID=$(curl -s -XPOST $API/api/sandboxes -H "x-api-key:$KEY" \
  -H content-type:application/json -d '{"exposedPorts":[5173]}' | jq -r .id)
curl -XPOST $API/api/sandboxes/$ID/fs/tree -H "x-api-key:$KEY" \
  -H content-type:application/json -d '{"tree":{"index.html":"<h1>hi</h1>"}}'
curl "$API/api/sandboxes/$ID/fs/file?path=index.html" -H "x-api-key:$KEY"
curl -XDELETE $API/api/sandboxes/$ID -H "x-api-key:$KEY"
```

Crash safety: `kill -9 $(systemctl show -p MainPID --value gibber)` and confirm
systemd restarts the service and the log reports `Reaped orphan container ...`
for every sandbox that was running.
