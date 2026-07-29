import asyncio, logging, asyncpg, os, httpx
from app.celery_app import celery

logger = logging.getLogger(__name__)

async def get_db():
    return await asyncpg.connect(os.getenv("DATABASE_URL","").replace("+asyncpg",""))

@celery.task(name="app.workers.scheduled.send_khata_reminders_all_stores")
def send_khata_reminders_all_stores():
    asyncio.run(_khata_reminders())

async def _khata_reminders():
    conn = await get_db()
    try:
        stores = await conn.fetch("SELECT id FROM stores WHERE is_suspended=FALSE")
        for s in stores:
            customers = await conn.fetch(
                """SELECT c.id, c.name, c.khata_balance, c.fcm_token
                   FROM customers c
                   WHERE c.store_id=$1 AND c.khata_balance > 0 AND c.dpdp_consent=TRUE
                     AND (SELECT MAX(sent_at) FROM khata_reminders WHERE customer_id=c.id AND store_id=$1)
                           < NOW() - INTERVAL '7 days'
                      OR  (SELECT COUNT(*) FROM khata_reminders WHERE customer_id=c.id AND store_id=$1) = 0""",
                s["id"])
            for c in customers:
                store_name = (await conn.fetchval("SELECT business_name FROM stores WHERE id=$1", s["id"])) or "Store"
                await conn.execute(
                    """INSERT INTO customer_inbox (customer_id,store_id,msg_type,title,body,metadata,channel_sent)
                       VALUES ($1,$2,'khata',$3,$4,$5,'["inbox"]'::jsonb)""",
                    c["id"], s["id"],
                    f"Payment Reminder - {store_name}",
                    f"Dear {c['name'] or 'Customer'}, your outstanding balance is Rs.{c['khata_balance']:.2f}. Please clear at your earliest convenience.",
                    f'{{"balance": {float(c["khata_balance"]):.2f}}}')
                await conn.execute(
                    "INSERT INTO khata_reminders (customer_id,store_id,balance_at_send,channel) VALUES ($1,$2,$3,'inbox')",
                    c["id"], s["id"], c["khata_balance"])
        logger.info(f"Khata reminders sent for {len(stores)} stores")
    finally:
        await conn.close()

@celery.task(name="app.workers.scheduled.check_expiry_alerts_all_stores")
def check_expiry_alerts_all_stores():
    asyncio.run(_expiry_alerts())

async def _expiry_alerts():
    conn = await get_db()
    try:
        rows = await conn.fetch(
            """SELECT ib.id, ib.product_id, ib.store_id, ib.expiry_date, ib.qty_remaining,
                      p.name AS product_name,
                      EXTRACT(DAY FROM ib.expiry_date - CURRENT_DATE) AS days_left
               FROM inventory_batches ib JOIN products p ON p.id=ib.product_id
               WHERE ib.qty_remaining > 0 AND ib.expiry_date IS NOT NULL
                 AND ib.expiry_date <= CURRENT_DATE + INTERVAL '30 days'""")
        for r in rows:
            days = int(r["days_left"] or 0)
            alert_type = ("expiry_7d" if days <= 7 else "expiry_15d" if days <= 15 else "expiry_30d")
            col_check  = f"alert_sent_{alert_type.replace('expiry_','')}"
            already    = await conn.fetchval(f"SELECT {col_check} FROM inventory_batches WHERE id=$1", r["id"])
            if not already:
                await conn.execute(
                    """INSERT INTO stock_alerts (product_id,store_id,alert_type,expiry_date,batch_id)
                       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING""",
                    r["product_id"], r["store_id"], alert_type, r["expiry_date"], r["id"])
                await conn.execute(f"UPDATE inventory_batches SET {col_check}=TRUE WHERE id=$1", r["id"])
        logger.info(f"Expiry alerts checked: {len(rows)} batches scanned")
    finally:
        await conn.close()

@celery.task(name="app.workers.scheduled.compute_cadence_all_stores")
def compute_cadence_all_stores():
    asyncio.run(_compute_cadence())

async def _compute_cadence():
    import statistics
    from datetime import timedelta
    conn = await get_db()
    try:
        pairs = await conn.fetch(
            """SELECT si.product_id, s.customer_id, s.store_id,
                      array_agg(s.billed_at ORDER BY s.billed_at) AS purchase_dates,
                      AVG(si.quantity) AS avg_qty
               FROM sale_items si JOIN sales s ON s.id=si.sale_id
               WHERE s.customer_id IS NOT NULL AND s.bill_type='sale'
                 AND s.billed_at > NOW() - INTERVAL '180 days'
               GROUP BY si.product_id, s.customer_id, s.store_id
               HAVING COUNT(*) >= 3""")
        updated = 0
        for p in pairs:
            try:
                dates     = [d for d in p["purchase_dates"] if d]
                if len(dates) < 3: continue
                intervals = [(dates[i+1]-dates[i]).days for i in range(len(dates)-1)]
                med       = statistics.median(intervals)
                if med <= 0: continue
                next_pred = dates[-1] + timedelta(days=int(med))
                await conn.execute(
                    """INSERT INTO purchase_cadence
                         (customer_id,product_id,store_id,data_points,median_interval_days,avg_qty_per_purchase,last_purchase_at,next_predicted_at,computed_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
                       ON CONFLICT (customer_id,product_id,store_id) DO UPDATE SET
                         data_points=$4,median_interval_days=$5,avg_qty_per_purchase=$6,
                         last_purchase_at=$7,next_predicted_at=$8,computed_at=NOW()""",
                    p["customer_id"],p["product_id"],p["store_id"],len(dates),med,p["avg_qty"],dates[-1],next_pred)
                updated += 1
            except Exception as e:
                logger.warning(f"Cadence pair error: {e}")
        logger.info(f"Cadence computed for {updated} customer-product pairs")
    finally:
        await conn.close()

@celery.task(name="app.workers.scheduled.recompute_all_trust_scores")
def recompute_all_trust_scores():
    asyncio.run(_trust_scores())

async def _trust_scores():
    conn = await get_db()
    try:
        stores = await conn.fetch("SELECT id FROM stores WHERE is_suspended=FALSE")
        for s in stores:
            async with httpx.AsyncClient() as c:
                await c.get(f"http://localhost:8000/api/v1/ads/trust-scores/recompute/{s['id']}")
        logger.info(f"Trust scores recomputed for {len(stores)} stores")
    finally:
        await conn.close()

@celery.task(name="app.workers.scheduled.update_ad_quality_scores")
def update_ad_quality_scores():
    asyncio.run(_ad_quality())

async def _ad_quality():
    conn = await get_db()
    try:
        campaigns = await conn.fetch(
            "SELECT id, clicks, impressions FROM ad_campaigns WHERE status='active' AND impressions > 50")
        for c in campaigns:
            ctr = float(c["clicks"]) / max(float(c["impressions"]),1)
            qs  = round(min(ctr * 0.6 + 0.8 * 0.4, 2.0), 4)
            await conn.execute("UPDATE ad_campaigns SET quality_score=$1 WHERE id=$2", qs, c["id"])
    finally:
        await conn.close()
