'use strict';

const logger   = require('../utils/logger');
const AppError = require('../utils/AppError');

function errorHandler(err, req, res, next) {
  let { statusCode = 500, message, isOperational } = err;

  if (!isOperational) {
    logger.error('Unexpected error:', {
      message: err.message,
      stack:   err.stack,
      url:     req.originalUrl,
      method:  req.method,
      user:    req.user?.id,
    });
  }

  // Postgres unique violation
  if (err.code === '23505') {
    statusCode = 409;
    message    = 'A record with this value already exists';
  }
  // Postgres FK violation
  if (err.code === '23503') {
    statusCode = 400;
    message    = 'Referenced record does not exist';
  }
  // JWT errors
  if (err.name === 'JsonWebTokenError') { statusCode = 401; message = 'Invalid token'; }
  if (err.name === 'TokenExpiredError') { statusCode = 401; message = 'Token expired'; }

  if (process.env.NODE_ENV === 'production' && statusCode === 500) {
    message = 'Internal server error';
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
}

module.exports = { errorHandler };
