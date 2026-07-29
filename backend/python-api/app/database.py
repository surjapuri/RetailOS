import asyncpg
from app.config import settings

pool = None

async def init_db():
    global pool
    pool = await asyncpg.create_pool(
        dsn=settings.DATABASE_URL.replace("+asyncpg",""),
        min_size=5, max_size=20,
        command_timeout=60,
    )

async def close_db():
    if pool: await pool.close()

def get_pool():
    return pool
