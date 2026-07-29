'use strict';
const { Worker } = require('bullmq');
const PDFDocument = require('pdfkit');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { db } = require('../config/database');
const { sendInboxMessage } = require('../modules/crm/crm.service');
const logger = require('../utils/logger');
const connection = { host:process.env.REDIS_HOST||'redis', port:6379, password:process.env.REDIS_PASSWORD };
const s3 = new S3Client({ region: process.env.S3_REGION });

async function generatePDF(sale, items) {
  return new Promise((resolve,reject) => {
    const doc = new PDFDocument({ size:'A5', margin:40 }), chunks=[];
    doc.on('data',c=>chunks.push(c)).on('end',()=>resolve(Buffer.concat(chunks))).on('error',reject);
    doc.fontSize(14).font('Helvetica-Bold').text(sale.business_name,{align:'center'});
    doc.fontSize(9).font('Helvetica').text(sale.address||'',{align:'center'});
    if(sale.gstin) doc.text(`GSTIN: ${sale.gstin}`,{align:'center'});
    doc.moveDown(0.5);
    doc.moveTo(40,doc.y).lineTo(400,doc.y).stroke().moveDown(0.3);
    doc.text(`Invoice: ${sale.invoice_number}   Date: ${new Date(sale.billed_at).toLocaleDateString('en-IN')}`);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(8);
    ['Item','Qty','Rate','Total'].forEach((h,i)=>doc.text(h,[40,200,280,370][i],doc.y,{width:100}));
    doc.moveDown(0.3).moveTo(40,doc.y).lineTo(430,doc.y).stroke().moveDown(0.2);
    doc.font('Helvetica').fontSize(8);
    for(const item of items){
      const y=doc.y;
      doc.text((item.product_name||'').slice(0,25),40,y,{width:155});
      doc.text(`${item.quantity} ${item.unit_type||''}`,200,y,{width:75});
      doc.text(`Rs.${parseFloat(item.effective_price).toFixed(2)}`,280,y,{width:85});
      doc.text(`Rs.${parseFloat(item.line_total).toFixed(2)}`,370,y,{width:70});
      doc.moveDown(0.8);
    }
    doc.moveDown(0.3).moveTo(40,doc.y).lineTo(430,doc.y).stroke().moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(10).text(`TOTAL: Rs.${parseFloat(sale.total_amount).toFixed(2)}`,{align:'right'});
    doc.moveDown(0.5).fontSize(8).font('Helvetica').text('Thank you!',{align:'center'});
    doc.end();
  });
}

const worker = new Worker('receipts', async(job)=>{
  const {saleId,customerId} = job.data;
  const [sR,iR,cR] = await Promise.all([
    db.query('SELECT s.*,st.business_name,st.gstin,b.address FROM sales s JOIN stores st ON st.id=s.store_id JOIN branches b ON b.id=s.branch_id WHERE s.id=$1',[saleId]),
    db.query('SELECT * FROM sale_items WHERE sale_id=$1',[saleId]),
    db.query('SELECT name,mobile,fcm_token FROM customers WHERE id=$1',[customerId])]);
  const sale=sR.rows[0]; if(!sale) return;
  const pdf = await generatePDF(sale,iR.rows);
  const key = `receipts/${sale.store_id}/${sale.invoice_number}.pdf`;
  await s3.send(new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:key,Body:pdf,ContentType:'application/pdf',ServerSideEncryption:'AES256'}));
  const url = `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;
  await sendInboxMessage(customerId,sale.store_id,{
    msg_type:'receipt',title:`Receipt: ${sale.invoice_number}`,
    body:`Your receipt for Rs.${parseFloat(sale.total_amount).toFixed(2)}. Thank you for shopping at ${sale.business_name}!`,
    action_url:url,metadata:{invoice_number:sale.invoice_number,amount:sale.total_amount,pdf_url:url}});
  logger.info(`Receipt sent: ${sale.invoice_number}`);
},{connection, concurrency:5});
worker.on('failed',(j,e)=>logger.error(`Receipt ${j?.id} failed:`,e.message));
module.exports = worker;
