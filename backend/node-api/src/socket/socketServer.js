'use strict';

const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/jwt');
const logger = require('../utils/logger');

let io;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: (process.env.CORS_ORIGINS || '').split(','),
      methods: ['GET','POST'],
      credentials: true,
    },
    pingTimeout:  60000,
    pingInterval: 25000,
  });

  // Auth middleware for socket connections
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded  = verifyAccessToken(token);
      socket.user    = decoded;
      socket.storeId = decoded.storeId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { storeId, sub: userId, role } = socket.user;

    // Join store room — all POS terminals in same store share a room
    socket.join(`store:${storeId}`);
    logger.info(`Socket connected: user=${userId} store=${storeId} role=${role}`);

    // POS terminal joins branch room for localised events
    socket.on('join-branch', (branchId) => {
      socket.join(`branch:${branchId}`);
    });

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: user=${userId}`);
    });
  });

  return io;
}

function getIO() { return io; }

module.exports = { initSocket, getIO };
