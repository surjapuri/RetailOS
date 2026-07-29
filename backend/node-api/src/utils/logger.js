'use strict';

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const fmt = winston.format;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: fmt.combine(
    fmt.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    fmt.errors({ stack: true }),
    fmt.json()
  ),
  defaultMeta: { service: 'retailos-api' },
  transports: [
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '30d',
      zippedArchive: true,
    }),
    new DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true,
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: fmt.combine(fmt.colorize(), fmt.simple()),
  }));
}

module.exports = logger;
