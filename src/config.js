'use strict';
require('dotenv').config();

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  port: int(process.env.PORT, 3000),
  apiKey: process.env.API_KEY || '',
  sandbox: {
    image: process.env.SANDBOX_IMAGE || 'node18-alpine-vite:latest',
    memoryMb: int(process.env.SANDBOX_MEMORY_MB, 512),
    cpus: num(process.env.SANDBOX_CPUS, 0.5),
    // "none" => fully air-gapped. Otherwise an internal bridge network you control.
    network: process.env.SANDBOX_NETWORK || 'sandbox_net',
    user: process.env.SANDBOX_USER || 'sandbox', // non-root user baked into the image
    workdir: '/home/sandbox/app',
    maxSandboxes: int(process.env.MAX_SANDBOXES, 20),
    ttlMs: int(process.env.SANDBOX_TTL_MS, 15 * 60 * 1000),
    gcIntervalMs: int(process.env.GC_INTERVAL_MS, 30 * 1000),
    pidsLimit: int(process.env.SANDBOX_PIDS_LIMIT, 128),
    diskQuotaMb: int(process.env.SANDBOX_DISK_MB, 512)
  },
  ports: {
    start: int(process.env.PORT_RANGE_START, 41000),
    end: int(process.env.PORT_RANGE_END, 41999)
  }
};
