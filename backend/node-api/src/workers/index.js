'use strict';
// Start all BullMQ workers
// In production, run this as a separate process: node src/workers/index.js
require('../config/database').initDB();
require('../config/redis').initRedis();
require('../config/firebase').initFirebase();
require('./receipts.worker');
require('./notifications.worker');
require('./loyalty.worker');
require('./whatsapp.worker');
const logger = require('../utils/logger');
logger.info('All BullMQ workers started');
