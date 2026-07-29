from fastapi import APIRouter, BackgroundTasks, Query
import logging, statistics
from app.database import get_pool
from datetime import datetime, timedelta

router = APIRouter()
logger = logging.getLogger(__name__)

@router.post("/cadence/compute/{store_id}")
async def compute_cadence(store_id: str, background_tasks: BackgroundTasks):
    """Trigger cadence recomputation for all customers of a store (called by Celery Beat)"""
    background_tasks.add_task(_recompute_store_cadence, store_id)
    return {"success": True, "message": "Cadence computation queued"}

async def _recompute_store_cadence(store_id: str):
    pool = get_pool()
    # Get all customer-product pairs with >= 3 purchases
    pairs = await pool.fetch(
        """SELECT si.product_id, s.customer_id, array_agg(s.billed_at ORDER BY s.billed_at) AS purchase_dates,
                  AVG(si.quantity) AS avg_qty
           FROM sale_items si JOIN sales s ON s.id=si.sale_id
           WHERE s.store_id=$1 AND s.customer_id IS NOT NULL AND s.bill_type='sale'
             AND s.billed_at > NOW() - INTERVAL '180 days'
           GROUP BY si.product_id, s.customer_id
           HAVING COUNT(*) >= 3""", store_id)

    for pair in pairs:
        try:
            dates = [d for d in pair["purchase_dates"] if d]
            if len(dates) < 3: continue
            intervals = [(dates[i+1]-dates[i]).days for i in range(len(dates)-1)]
            median_interval = statistics.median(intervals)
            if median_interval <= 0: continue
            last_purchase = dates[-1]
            next_predicted = last_purchase + timedelta(days=int(median_interval))
            await pool.execute(
                """INSERT INTO purchase_cadence
                     (customer_id,product_id,store_id,data_points,median_interval_days,
                      avg_qty_per_purchase,last_purchase_at,next_predicted_at,computed_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
                   ON CONFLICT (customer_id,product_id,store_id) DO UPDATE SET
                     data_points=$4, median_interval_days=$5, avg_qty_per_purchase=$6,
                     last_purchase_at=$7, next_predicted_at=$8, computed_at=NOW()""",
                pair["customer_id"], pair["product_id"], store_id, len(dates),
                median_interval, pair["avg_qty"], last_purchase, next_predicted)
        except Exception as e:
            logger.error(f"Cadence compute error: {e}")

@router.get("/nudges/pending")
async def get_pending_nudges(store_id:str=Query(...)):
    """Get customers due for a reorder nudge (next_predicted within 3 days)"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT pc.*, c.name AS customer_name, c.fcm_token, p.name AS product_name
           FROM purchase_cadence pc
           JOIN customers c ON c.id=pc.customer_id
           JOIN products p ON p.id=pc.product_id
           WHERE pc.store_id=$1 AND pc.is_active=TRUE AND pc.data_points >= 3
             AND pc.consecutive_dismissals < 3
             AND pc.next_predicted_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
             AND (pc.nudge_sent_at IS NULL OR pc.nudge_sent_at < NOW() - INTERVAL '7 days')""",
        store_id)
    return {"success": True, "nudges": [dict(r) for r in rows]}

@router.post("/nudges/{cadence_id}/dismiss")
async def dismiss_nudge(cadence_id:str):
    pool = get_pool()
    await pool.execute(
        "UPDATE purchase_cadence SET consecutive_dismissals=consecutive_dismissals+1 WHERE id=$1", cadence_id)
    return {"success": True}
