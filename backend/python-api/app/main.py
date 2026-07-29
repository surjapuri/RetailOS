from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging

from app.config import settings
from app.database import init_db, close_db
from app.b2b.router     import router as b2b_router
from app.ai.router      import router as ai_router
from app.ads.router     import router as ads_router
from app.geo.router     import router as geo_router

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    logger.info("Database pool ready")
    yield
    await close_db()
    logger.info("Shutdown complete")

app = FastAPI(
    title="RetailOS Python API",
    description="B2B Aggregator, AI Cadence Engine, Ad Auction, Geo Services",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.DEBUG else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(b2b_router,  prefix="/api/v1/b2b",  tags=["B2B Procurement"])
app.include_router(ai_router,   prefix="/api/v1/ai",   tags=["AI Cadence"])
app.include_router(ads_router,  prefix="/api/v1/ads",  tags=["Ad Auction"])
app.include_router(geo_router,  prefix="/api/v1/geo",  tags=["Geo Services"])

@app.get("/health")
async def health():
    return {"status": "ok", "service": "retailos-python-api"}
