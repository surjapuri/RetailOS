'use strict';
const { Worker } = require('bullmq');
const { creditPoints } = require('../modules/crm/crm.service');
const logger = require('../utils/logger');
const connection = { host:process.env.REDIS_HOST||'redis', port:6379, password:process.env.REDIS_PASSWORD };
const worker = new Worker('loyalty', async(job)=>{
  if(job.name==='credit-points'){
    const {customerId,storeId,saleId,amount} = job.data;
    await creditPoints(customerId,storeId,saleId,amount);
  }
},{connection, concurrency:20});
worker.on('failed',(j,e)=>logger.error(`Loyalty ${j?.id} failed:`,e.message));
module.exports = worker;
