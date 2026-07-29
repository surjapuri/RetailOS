'use strict';

const logger = require('../utils/logger');

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn' : 'http';
    logger[level]({
      method:   req.method,
      url:      req.originalUrl,
      status:   res.statusCode,
      duration: `${duration}ms`,
      ip:       req.ip,
      user:     req.user?.id || 'anon',
    });
  });
  next();
}

module.exports = { requestLogger };
