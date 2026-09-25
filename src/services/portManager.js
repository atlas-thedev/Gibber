'use strict';
const net = require('net');
const { Exhausted } = require('../utils/errors');
const log = require('../utils/logger');

/**
 * Hands out host ports from a fixed range.
 *
 * Why not let Docker pick (`PublishAllPorts`)? Because on a busy box Docker can
 * still collide with ports opened by other processes between our check and the
 * container start. We therefore:
 *   1. reserve the port in-memory (so two concurrent creates never pick the same one)
 *   2. probe it with a real bind() to catch ports used outside Docker
 *   3. release it again if container creation fails (no leaked reservations)
 */
class PortManager {
  constructor({ start, end }) {
    this.start = start;
    this.end = end;
    this.reserved = new Set();
    this.cursor = start;
  }

  static isFree(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '0.0.0.0');
    });
  }

  /** Reserve `count` host ports. Throws 503 instead of hanging when the range is full. */
  async acquire(count = 1) {
    const out = [];
    const total = this.end - this.start + 1;
    let scanned = 0;

    while (out.length < count) {
      if (scanned++ > total) {
        out.forEach((p) => this.release(p));
        throw Exhausted(
          `No free host port in range ${this.start}-${this.end}. ` +
            'Increase PORT_RANGE_END or reap idle sandboxes.'
        );
      }
      const port = this.cursor;
      this.cursor = this.cursor >= this.end ? this.start : this.cursor + 1;

      if (this.reserved.has(port)) continue;
      this.reserved.add(port); // reserve first -> no race with a parallel acquire
      // eslint-disable-next-line no-await-in-loop
      if (await PortManager.isFree(port)) out.push(port);
      else this.reserved.delete(port);
    }
    return out;
  }

  release(port) {
    if (this.reserved.delete(port)) log.debug(`port ${port} released`);
  }

  get stats() {
    return { range: [this.start, this.end], inUse: this.reserved.size };
  }
}

module.exports = PortManager;
