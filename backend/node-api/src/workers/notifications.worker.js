'use strict';
const { Worker } = require('bullmq');
const { sendFCM } = require('../utils/fcm');
const { db }      = require('../config/database');
const logger      = require('../utils/logger');
const connection  = { host:process.env.REDIS_HOST||'redis', port:6379, password:process.env.REDIS_PASSWORD };

const worker = new Worker('notifications', async(job)=>{
  if(job.name==='send-fcm'){
    await sendFCM(job.data.token,{title:job.data.title,body:job.data.body,data:job.data.data});
  } else if(job.name==='soundbox-trigger'){
    const {getIO} = require('../socket/socketServer');
    const io = getIO();
    if(io) io.to(`branch:${job.data.branchId}`).emit('payment_confirmed',{amount:job.data.amount,method:job.data.method,playAudio:true});
  } else if(job.name==='sla-watchdog'){
    const r = await db.query("SELECT id,respondent_id FROM grievance_tickets WHERE id=$1 AND status='open'",[job.data.ticketId]);
    if(r.rows[0]){
      await db.query("UPDATE grievance_tickets SET status='escalated',escalated_at=NOW() WHERE id=$1",[job.data.ticketId]);
      await db.query("UPDATE store_trust_scores SET response_rate=GREATEST(0,response_rate-10) WHERE store_id=$1",[r.rows[0].respondent_id]);
      logger.warn(`Grievance ${job.data.ticketId} auto-escalated`);
    }
  } else if(job.name==='recompute-trust-score'){
    const axios = require('axios');
    await axios.get(`http://python-api:8000/api/v1/ads/trust-scores/recompute/${job.data.storeId}`).catch(e=>logger.warn(e.message));
  }
},{connection, concurrency:10});
worker.on('failed',(j,e)=>logger.error(`Notification ${j?.id}(${j?.name}) failed:`,e.message));
module.exports = worker;
