'use strict';

const admin  = require('firebase-admin');
const logger = require('./logger');

async function sendFCM(token, { title, body, data = {} }) {
  if (!token) return null;
  try {
    const msg = {
      token,
      notification: { title, body },
      data:         Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
      android:      { priority: 'high', notification: { sound: 'default' } },
      apns:         { payload: { aps: { sound: 'default', badge: 1 } } },
    };
    const result = await admin.messaging().send(msg);
    return result;
  } catch (err) {
    logger.warn(`FCM send failed for token ${token?.slice(0,20)}:`, err.message);
    return null;
  }
}

async function sendFCMMulticast(tokens, { title, body, data = {} }) {
  if (!tokens?.length) return;
  const validTokens = tokens.filter(Boolean);
  if (!validTokens.length) return;

  // FCM allows max 500 tokens per multicast
  const chunks = [];
  for (let i = 0; i < validTokens.length; i += 500) {
    chunks.push(validTokens.slice(i, i + 500));
  }

  for (const chunk of chunks) {
    try {
      await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
        android: { priority: 'high' },
      });
    } catch (err) {
      logger.warn('FCM multicast error:', err.message);
    }
  }
}

module.exports = { sendFCM, sendFCMMulticast };
