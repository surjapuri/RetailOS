from fastapi import APIRouter, Query
from app.database import get_pool
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

@router.get("/trust-scores/recompute/{store_id}")
async def recompute_trust_score(store_id: str):
    """Recompute TrustScore for a store (0-5 composite)"""
    pool = get_pool()
    row = await pool.fetchrow(
        """SELECT
             COALESCE(AVG(rating) FILTER (WHERE is_hidden=FALSE AND is_suspicious=FALSE), 0) AS avg_r,
             COUNT(*) FILTER (WHERE is_hidden=FALSE AND is_suspicious=FALSE) AS total_r
           FROM store_ratings WHERE store_id=$1""", store_id)
    avg_r   = float(row["avg_r"] or 0)
    total_r = int(row["total_r"] or 0)

    # Response rate from grievance tickets
    griev = await pool.fetchrow(
        """SELECT
             COUNT(*) AS total_t,
             COUNT(*) FILTER (WHERE status IN ('responded','resolved','closed')) AS responded_t
           FROM grievance_tickets WHERE respondent_id=$1 AND created_at > NOW()-INTERVAL '90 days'""",
        store_id)
    total_t    = int(griev["total_t"] or 1)
    responded_t = int(griev["responded_t"] or 0)
    resp_rate  = (responded_t / total_t) * 100

    # Composite TrustScore
    trust = round((avg_r * 0.6) + (min(resp_rate,100)/100 * 5 * 0.2) + (3.0 * 0.2), 2)
    status = "good" if trust >= 3.5 else "low" if trust >= 2.0 else "review_flag"

    await pool.execute(
        """INSERT INTO store_trust_scores (store_id,avg_rating,total_ratings,response_rate,trust_score,score_status,last_computed_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (store_id) DO UPDATE SET
             avg_rating=$2,total_ratings=$3,response_rate=$4,trust_score=$5,score_status=$6,last_computed_at=NOW()""",
        store_id, avg_r, total_r, resp_rate, trust, status)

    return {"success":True,"store_id":store_id,"trust_score":trust,"avg_rating":avg_r,"status":status}
