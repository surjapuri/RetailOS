import asyncio, logging, os, httpx
from app.celery_app import celery

logger = logging.getLogger(__name__)

@celery.task(name="app.workers.notification.send_ai_nudges")
def send_ai_nudges(store_id: str):
    asyncio.run(_send_nudges(store_id))

async def _send_nudges(store_id: str):
    async with httpx.AsyncClient() as c:
        resp = await c.get(f"http://localhost:8000/api/v1/ai/nudges/pending?store_id={store_id}")
        if resp.status_code != 200: return
        nudges = resp.json().get("nudges", [])
        for nudge in nudges:
            if not nudge.get("fcm_token"): continue
            payload = {
                "token":  nudge["fcm_token"],
                "title":  f"Time to restock {nudge['product_name']}!",
                "body":   f"You usually buy {nudge['product_name']} around now. Visit us today!",
                "data":   {"type":"reorder","product_id":nudge["product_id"],"store_id":store_id},
            }
            await c.post("http://node-api:4000/api/v1/internal/fcm", json=payload)
            await c.post(f"http://localhost:8000/api/v1/ai/nudges/{nudge['id']}/dismiss")
