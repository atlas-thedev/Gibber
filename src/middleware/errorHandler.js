'use strict';
const log = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) log.error(err.stack || err.message);
  res.status(status).json({
    error: { code: err.code || 'INTERNAL_ERROR', message: err.message, details: err.details }
  });
};
