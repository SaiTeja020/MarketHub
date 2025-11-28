# services/scrape_service.py
import json
from utils.rabbit import publish_message
from utils.redis_client import get_redis
from typing import Any

async def publish_scrape_job(source: str, payload: dict):
    """
    Publish a message to the scraping queue for `source`.
    Example queue names: "scrape.amazon", "scrape.flipkart"
    """
    queue_name = f"scrape.{source.lower()}"
    await publish_message(queue_name, json.dumps(payload))
    return True

async def fetch_result(task_id: str) -> Any | None:
    """
    Fetch result from Redis saved by the scraper worker using task_id.
    Returns None if not present.
    """
    redis = await get_redis()
    key = f"scrape:result:{task_id}"
    raw = await redis.get(key)
    if raw is None:
        return None
    # assume JSON stored
    try:
        import json
        return json.loads(raw)
    except Exception:
        return raw
