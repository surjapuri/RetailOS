from fastapi import APIRouter, Query
import asyncio, httpx, logging, json
from app.config import settings
from app.database import get_pool

router = APIRouter()
logger = logging.getLogger(__name__)

async def _fetch_udaan(product_name, qty):
    if not settings.UDAAN_CLIENT_ID:
        return {"platform":"udaan","available":False,"reason":"not_configured"}
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{settings.UDAAN_BASE_URL}/catalog/search",
                params={"q":product_name,"qty":qty},
                headers={"Authorization":f"Bearer {settings.UDAAN_CLIENT_ID}"})
            if r.status_code == 200:
                d = r.json()
                return {"platform":"udaan","available":True,"unit_price":d.get("price"),
                        "min_order":d.get("min_qty"),"delivery_days":d.get("delivery_days",3)}
    except Exception as e: logger.warning(f"UDAAN: {e}")
    return {"platform":"udaan","available":False,"reason":"api_error"}

async def _fetch_jiomart(product_name, qty):
    if not settings.JIOMART_API_KEY:
        return {"platform":"jiomart","available":False,"reason":"not_configured"}
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{settings.JIOMART_BASE_URL}/products/search",
                params={"q":product_name,"quantity":qty},
                headers={"x-api-key":settings.JIOMART_API_KEY})
            if r.status_code == 200:
                d = r.json()
                return {"platform":"jiomart","available":True,"unit_price":d.get("wholesale_price"),
                        "min_order":d.get("minimum_order_qty"),"delivery_days":d.get("edd_days",2)}
    except Exception as e: logger.warning(f"JioMart: {e}")
    return {"platform":"jiomart","available":False,"reason":"api_error"}

async def _fetch_local(store_id, product_name):
    pool = get_pool()
    rows = await pool.fetch(
        "SELECT id,name,contact FROM suppliers WHERE store_id=$1 AND is_active=TRUE", store_id)
    return [{"platform":f"local:{r['name']}","available":True,"supplier_id":str(r['id']),
             "supplier_name":r['name'],"contact":r['contact'],"requires_negotiation":True} for r in rows]

@router.get("/compare-prices")
async def compare_prices(product_name:str=Query(...,min_length=2),
                          qty:float=Query(...,gt=0), store_id:str=Query(...)):
    results = await asyncio.gather(_fetch_udaan(product_name,qty),
                                    _fetch_jiomart(product_name,qty),
                                    _fetch_local(store_id,product_name), return_exceptions=True)
    platforms = []
    for r in results:
        if isinstance(r, list): platforms.extend(r)
        elif isinstance(r, dict): platforms.append(r)
    platforms.sort(key=lambda x: x.get("unit_price") or float("inf"))
    return {"success":True,"product":product_name,"qty":qty,"platforms":platforms}

@router.post("/orders")
async def place_order(payload:dict):
    pool = get_pool()
    row = await pool.fetchrow(
        "INSERT INTO purchase_orders (store_id,platform,status,items,total_amount,ordered_by) VALUES ($1,$2,'submitted',$3,$4,$5) RETURNING id",
        payload["store_id"], payload.get("platform","manual"),
        json.dumps(payload.get("items",[])), payload.get("total_amount",0), payload.get("ordered_by"))
    return {"success":True,"order_id":str(row["id"]),"status":"submitted"}
