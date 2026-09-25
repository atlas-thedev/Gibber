'use strict';
const path = require('path');
const { BadRequest } = require('./errors');

/**
 * Sandbox paths are attacker-controlled. We normalise them and refuse anything
 * that escapes the workdir (../../etc/passwd) or targets sensitive mounts.
 * Defence in depth: the container is unprivileged and read-only outside /home.
 */
function resolveSandboxPath(workdir, input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw BadRequest('path must be a non-empty string');
  }
  if (input.includes('\0')) throw BadRequest('path contains a null byte');

  const abs = path.posix.normalize(
    path.posix.isAbsolute(input) ? input : path.posix.join(workdir, input)
  );
  if (!abs.startsWith(workdir + '/') && abs !== workdir) {
    throw BadRequest(`path must stay inside ${workdir}`);
  }
  return abs;
}

module.exports = { resolveSandboxPath };
