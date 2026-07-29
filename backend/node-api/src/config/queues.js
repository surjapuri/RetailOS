'use strict';

const { Queue, Worker } = require('bullmq');
const { redis }  = require('./redis');
const logger     = require('../utils/logger');

const connection = { host: process.env.REDIS_HOST || 'redis', port: 6379,
                     password: process.env.REDIS_PASSWORD };

const queues = {};

const QUEUE_NAMES = ['receipts','notifications','whatsapp','loyalty','broadcasts','khata-reminders'];

async function initQueues() {
  for (const name of QUEUE_NAMES) {
    queues[name] = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts:           3,
        backoff:            { type: 'exponential', delay: 2000 },
        removeOnComplete:   { count: 500 },
        removeOnFail:       { count: 200 },
      },
    });
    logger.info(`Queue ready: ${name}`);
  }
}

function getQueue(name) {
  if (!queues[name]) throw new Error(`Queue '${name}' not initialised`);
  return queues[name];
}

module.exports = { initQueues, getQueue };
