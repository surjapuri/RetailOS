'use strict';

const admin  = require('firebase-admin');
const logger = require('../utils/logger');

function initFirebase() {
  if (admin.apps.length) return;
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
  logger.info('Firebase Admin SDK initialised');
}

module.exports = { initFirebase };
