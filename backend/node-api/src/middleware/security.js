'use strict';

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options',    'nosniff');
  res.setHeader('X-Frame-Options',           'DENY');
  res.setHeader('Referrer-Policy',           'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',        'geolocation=(), microphone=(), camera=()');
  res.removeHeader('X-Powered-By');
  next();
}

module.exports = { securityHeaders };
