'use strict';
const { Router } = require('express');
const docker = require('../services/dockerService');
const { asyncHandler, BadRequest } = require('../utils/errors');

// mounted at /api/sandboxes/:id/fs
const router = Router({ mergeParams: true });

// GET /api/sandboxes/:id/fs/file?path=src/App.jsx
router.get('/file', asyncHandler(async (req, res) => {
  const { path: p, encoding } = req.query;
  res.json(await docker.readFile(req.params.id, p, { encoding: encoding || 'utf8' }));
}));

// PUT /api/sandboxes/:id/fs/file  { path, content, encoding? }
router.put('/file', asyncHandler(async (req, res) => {
  const { path: p, content, encoding, mode } = req.body || {};
  if (!p) throw BadRequest('path is required');
  res.json(await docker.writeFiles(req.params.id, [{ path: p, content, encoding, mode }]));
}));

// POST /api/sandboxes/:id/fs/batch  { files: [{path, content}] }  — one tar, one call
router.post('/batch', asyncHandler(async (req, res) => {
  res.json(await docker.writeFiles(req.params.id, (req.body || {}).files));
}));

// POST /api/sandboxes/:id/fs/tree   { tree: { "src": { "App.jsx": "…" } } }
router.post('/tree', asyncHandler(async (req, res) => {
  const { tree, base } = req.body || {};
  if (!tree || typeof tree !== 'object') throw BadRequest('tree object is required');
  res.json(await docker.writeTree(req.params.id, tree, base || '.'));
}));

router.get('/list', asyncHandler(async (req, res) => {
  res.json(await docker.listDir(req.params.id, req.query.path || '.'));
}));

router.delete('/file', asyncHandler(async (req, res) => {
  const p = req.query.path || (req.body || {}).path;
  if (!p) throw BadRequest('path is required');
  res.json(await docker.deletePath(req.params.id, p));
}));

module.exports = router;
