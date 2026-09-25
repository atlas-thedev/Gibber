'use strict';
const stamp = () => new Date().toISOString();
const write = (level, args) =>
  console[level === 'debug' ? 'log' : level](`[${stamp()}] [${level.toUpperCase()}]`, ...args);

module.exports = {
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  debug: (...a) => (process.env.DEBUG ? write('debug', a) : undefined)
};
