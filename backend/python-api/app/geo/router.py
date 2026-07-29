from fastapi import APIRouter
router = APIRouter()
# Geo is handled in Node.js via PostGIS; this is a stub for future Python geo services
@router.get("/ping")
async def ping(): return {"service":"geo","status":"ok"}
