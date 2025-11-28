# utils/redis_client.py
import os
import aioredis

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
_redis = None

async def get_redis():
    global _redis
    if _redis is None:
        _redis = await aioredis.from_url(REDIS_URL, encoding="utf-8", decode_responses=True)
    return _redis
