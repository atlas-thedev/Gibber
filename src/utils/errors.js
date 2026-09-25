'use strict';

/** Typed error so routes can translate failures into proper HTTP codes. */
class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL_ERROR', details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const NotFound = (m = 'Not found') => new AppError(m, 404, 'NOT_FOUND');
const BadRequest = (m = 'Bad request', d) => new AppError(m, 400, 'BAD_REQUEST', d);
const Conflict = (m = 'Conflict') => new AppError(m, 409, 'CONFLICT');
const Exhausted = (m = 'Capacity exhausted') => new AppError(m, 503, 'CAPACITY_EXHAUSTED');

/** Wrap async route handlers so rejected promises reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { AppError, NotFound, BadRequest, Conflict, Exhausted, asyncHandler };
