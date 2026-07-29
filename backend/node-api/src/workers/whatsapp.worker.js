'use strict';
const { Worker } = require('bullmq');
const axios  = require('axios');
const { db } = require('../config/database');
const logger = require('../utils/logger');
const connection = { host:process.env.REDIS_HOST||'redis', port:6379, password:process.env.REDIS_PASSWORD };
const WA_URL = `https://graph.facebook.com/v18.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;

const worker = new Worker('whatsapp', async(job)=>{
  if(!process.env.WA_ACCESS_TOKEN) return;
  const {customerId,storeId,msg_type,title,body,metadata} = job.data;
  const cR = await db.query('SELECT mobile,dpdp_consent FROM customers WHERE id=$1',[customerId]);
  const c  = cR.rows[0];
  if(!c?.dpdp_consent || !c?.mobile) return;
  const phone = c.mobile.startsWith('91') ? c.mobile : `91${c.mobile}`;
  let msg = `${title}\n\n${body}`;
  if(metadata?.pdf_url) msg += `\n\nReceipt: ${metadata.pdf_url}`;
  await axios.post(WA_URL,{messaging_product:'whatsapp',to:phone,type:'text',text:{body:msg}},
    {headers:{Authorization:`Bearer ${process.env.WA_ACCESS_TOKEN}`,'Content-Type':'application/json'}});
},{connection, concurrency:5});
worker.on('failed',(j,e)=>logger.error(`WA ${j?.id} failed:`,e.message));
module.exports = worker;
