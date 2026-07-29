'use strict';
const { db }       = require('../../config/database');
const { getQueue } = require('../../config/queues');
const AppError     = require('../../utils/AppError');

const SLA_HOURS = { b2c: 48, b2b: 72 };

async function createTicket(data) {
  const { complainantId, complainantType, respondentId, respondentType,
          type, category, description, evidenceUrls, saleId, poId } = data;
  const slaH  = SLA_HOURS[type] || 48;
  const slaAt = new Date(Date.now() + slaH * 3600 * 1000);
  const seqRes = await db.query(`SELECT generate_ticket_number() AS num`);
  const ticketNumber = seqRes.rows[0].num;
  const result = await db.query(
    `INSERT INTO grievance_tickets
       (ticket_number,type,complainant_id,complainant_type,respondent_id,respondent_type,
        category,description,evidence_urls,sale_id,po_id,sla_deadline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [ticketNumber, type, complainantId, complainantType, respondentId, respondentType,
     category, description, evidenceUrls || [], saleId || null, poId || null, slaAt]);
  const ticket = result.rows[0];
  await getQueue('notifications').add('sla-watchdog', { ticketId: ticket.id, type }, { delay: slaH * 3600 * 1000 });
  return ticket;
}

async function addMessage(ticketId, authorId, authorType, message, attachments) {
  const r = await db.query(
    `INSERT INTO grievance_messages (ticket_id,author_id,author_type,message,attachments)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [ticketId, authorId, authorType, message, attachments || []]);
  const ticket = await db.query(`SELECT respondent_id, status FROM grievance_tickets WHERE id=$1`, [ticketId]);
  if (ticket.rows[0]?.respondent_id === authorId && ticket.rows[0]?.status === 'open') {
    await db.query(`UPDATE grievance_tickets SET status='responded',updated_at=NOW() WHERE id=$1`, [ticketId]);
  }
  return r.rows[0];
}

async function resolveTicket(ticketId, resolutionNote) {
  const r = await db.query(
    `UPDATE grievance_tickets SET status='resolved',resolved_at=NOW(),resolution_note=$2,updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [ticketId, resolutionNote]);
  if (!r.rows[0]) throw new AppError('Ticket not found', 404);
  await getQueue('notifications').add('recompute-trust-score', { storeId: r.rows[0].respondent_id });
  return r.rows[0];
}

async function getTickets(entityId, entityType, page, limit, status) {
  page = page || 1; limit = limit || 20;
  const offset = (page - 1) * limit;
  const params = [entityId, entityType, limit, offset];
  let whereStatus = status ? ` AND gt.status=$5` : '';
  if (status) params.push(status);
  const r = await db.query(
    `SELECT gt.*, json_agg(gm ORDER BY gm.created_at) FILTER (WHERE gm.id IS NOT NULL) AS messages
     FROM grievance_tickets gt
     LEFT JOIN grievance_messages gm ON gm.ticket_id=gt.id
     WHERE (gt.complainant_id=$1 AND gt.complainant_type=$2
         OR gt.respondent_id=$1 AND gt.respondent_type=$2)
     ${whereStatus}
     GROUP BY gt.id ORDER BY gt.created_at DESC LIMIT $3 OFFSET $4`,
    params);
  return r.rows;
}

module.exports = { createTicket, addMessage, resolveTicket, getTickets };
