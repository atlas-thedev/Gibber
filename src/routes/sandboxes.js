'use strict';
const { Router } = require('express');
const docker = require('../services/dockerService');
const { asyncHandler, BadRequest } = require('../utils/errors');

const router = Router();

// POST /api/sandboxes -> create + start a sandbox
router.post('/', asyncHandler(async (req, res) => {
  const { image, exposedPorts, env, cmd } = req.body || {};
  const sandbox = await docker.createSandbox({ image, exposedPorts, env, cmd });
  res.status(201).json(sandbox);
}));

// GET /api/sandboxes -> registry snapshot (includes idle time + TTL countdown)
router.get('/', (_req, res) => res.json({ sandboxes: docker.list(), ports: docker.ports.stats }));

router.get('/:id', asyncHandler(async (req, res) => {
  const s = docker.get(req.params.id);
  res.json({ ...s, idleMs: Date.now() - s.lastActivity });
}));

router.get('/:id/stats', asyncHandler(async (req, res) => res.json(await docker.stats(req.params.id))));

// Explicit keep-alive for clients that are "open but idle" (editor focused, etc.)
router.post('/:id/heartbeat', asyncHandler(async (req, res) => {
  const s = docker.get(req.params.id);
  docker.touch(s.id);
  res.json({ ok: true, lastActivity: s.lastActivity });
}));

// Short blocking command (npm install, ls…). Long-running jobs belong on the socket.
router.post('/:id/exec', asyncHandler(async (req, res) => {
  const { cmd, cwd, timeoutMs } = req.body || {};
  if (!cmd) throw BadRequest('cmd is required (string or string[])');
  const argv = Array.isArray(cmd) ? cmd : ['sh', '-lc', cmd];
  res.json(await docker.execCollect(req.params.id, argv, { cwd, timeoutMs }));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const ok = await docker.destroySandbox(req.params.id, 'api');
  res.status(ok ? 200 : 404).json({ deleted: ok });
}));

module.exports = router;
