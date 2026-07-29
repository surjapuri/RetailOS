'use strict';

require('dotenv').config();
const express       = require('express');
const http          = require('http');
const helmet        = require('helmet');
const cors          = require('cors');
const compression   = require('compression');
const morgan        = require('morgan');

const { initDB }         = require('./config/database');
const { initRedis }      = require('./config/redis');
const { initSocket }     = require('./socket/socketServer');
const { initQueues }     = require('./config/queues');
const { initFirebase }   = require('./config/firebase');
const logger             = require('./utils/logger');
const { rateLimiter }    = require('./middleware/rateLimiter');
const { errorHandler }   = require('./middleware/errorHandler');
const { requestLogger }  = require('./middleware/requestLogger');
const { securityHeaders} = require('./middleware/security');

// Route imports
const authRoutes       = require('./modules/auth/auth.routes');
const posRoutes        = require('./modules/pos/pos.routes');
const paymentsRoutes   = require('./modules/payments/payments.routes');
const inventoryRoutes  = require('./modules/inventory/inventory.routes');
const crmRoutes        = require('./modules/crm/crm.routes');
const rbacRoutes       = require('./modules/rbac/rbac.routes');
const geoRoutes        = require('./modules/geo/geo.routes');
const khataRoutes      = require('./modules/khata/khata.routes');
const grievanceRoutes  = require('./modules/grievance/grievance.routes');
const syncRoutes       = require('./modules/sync/sync.routes');
const adsRoutes        = require('./modules/ads/ads.routes');
const adminRoutes      = require('./modules/admin/admin.routes');
const webhookRoutes    = require('./modules/payments/webhook.routes');

const app    = express();
const server = http.createServer(app);

// ─────────────────────────────────────────────
// SECURITY MIDDLEWARE
// ─────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

app.use(securityHeaders);

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Device-ID','X-Store-ID'],
}));

// ─────────────────────────────────────────────
// GENERAL MIDDLEWARE
// ─────────────────────────────────────────────
app.use(compression());
app.use(morgan('combined', { stream: { write: msg => logger.http(msg.trim()) } }));
app.use(requestLogger);

// IMPORTANT: Raw body for webhook signature verification MUST come before json parser
app.use('/webhooks', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────
app.use('/api/', rateLimiter.api);
app.use('/api/v1/auth/', rateLimiter.auth);
app.use('/api/v1/payments/', rateLimiter.payments);

// ─────────────────────────────────────────────
// HEALTH CHECK (no auth required)
// ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const { db }    = require('./config/database');
  const { redis } = require('./config/redis');

  try {
    await db.query('SELECT 1');
    await redis.ping();
    res.json({
      status:    'ok',
      version:   '2.0.0',
      timestamp: new Date().toISOString(),
      services:  { database: 'ok', redis: 'ok' },
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
});

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────
const API = '/api/v1';

// Public
app.use(`${API}/auth`,         authRoutes);
app.use('/webhooks',           webhookRoutes);

// Store-scoped (JWT required)
app.use(`${API}/pos`,          posRoutes);
app.use(`${API}/payments`,     paymentsRoutes);
app.use(`${API}/inventory`,    inventoryRoutes);
app.use(`${API}/crm`,          crmRoutes);
app.use(`${API}/rbac`,         rbacRoutes);
app.use(`${API}/geo`,          geoRoutes);
app.use(`${API}/khata`,        khataRoutes);
app.use(`${API}/grievance`,    grievanceRoutes);
app.use(`${API}/sync`,         syncRoutes);
app.use(`${API}/ads`,          adsRoutes);

// Super Admin (separate JWT + TOTP + IP check)
app.use(`${API}/superadmin`,   adminRoutes);

// ─────────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ─────────────────────────────────────────────
// GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────
app.use(errorHandler);

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────
async function bootstrap() {
  try {
    await initDB();
    logger.info('✅ Database connected');

    await initRedis();
    logger.info('✅ Redis connected');

    initFirebase();
    logger.info('✅ Firebase Admin initialised');

    await initQueues();
    logger.info('✅ BullMQ queues initialised');

    initSocket(server);
    logger.info('✅ Socket.io initialised');

    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => {
      logger.info(`🚀 RetailOS API running on port ${PORT} [${process.env.NODE_ENV}]`);
    });
  } catch (err) {
    logger.error('❌ Startup failed:', err);
    process.exit(1);
  }
}

// Graceful shutdown
const shutdown = (signal) => {
  logger.info(`Received ${signal} — graceful shutdown...`);
  server.close(async () => {
    const { db }    = require('./config/database');
    const { redis } = require('./config/redis');
    await db.end();
    await redis.quit();
    logger.info('Server closed. Goodbye.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => { logger.error('Uncaught Exception:', err);  process.exit(1); });
process.on('unhandledRejection', (err) => { logger.error('Unhandled Rejection:', err); process.exit(1); });

bootstrap();

module.exports = app; // for tests
