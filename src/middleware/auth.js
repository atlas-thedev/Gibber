'use strict';
const config = require('../config');
const { AppError } = require('../utils/errors');

/** Optional shared-secret guard. Set API_KEY in .env to enable. */
module.exports = function auth(req, _res, next) {
  if (!config.apiKey) return next();
  if (req.get('x-api-key') === config.apiKey) return next();
  next(new AppError('Invalid or missing x-api-key', 401, 'UNAUTHORIZED'));
};
