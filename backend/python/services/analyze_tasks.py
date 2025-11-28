# tasks/analyze_tasks.py
from utils.celery_app import celery_app
from utils.redis_client import get_redis
import json
import time
import os
import uuid

@celery_app.task(name="analyze.product")
def analyze_product(payload: dict):
    """
    Celery task to call the LLM (Gemini) to perform deal credibility
    analysis. Replace the `call_gemini` stub with your preferred SDK calls.
    """
    task_id = payload.get("task_id") or str(uuid.uuid4())
    # 1) Compose prompt / input
    prompt = {
        "title": payload.get("title"),
        "product_id": payload.get("product_id"),
        "image_url": payload.get("image_url"),
        "current_price": payload.get("current_price"),
    }

    # 2) Call LLM (placeholder)
    llm_response = call_gemini(prompt)

    # 3) Process/format result
    result = {
        "task_id": task_id,
        "analysis": llm_response,
        "completed_at": time.time()
    }

    # 4) Store into Redis for retrieval by API
    import asyncio
    async def _store():
        redis = await get_redis()
        key = f"analyze:result:{task_id}"
        await redis.set(key, json.dumps(result), ex=60*60*24)  # keep 24h
    asyncio.get_event_loop().run_until_complete(_store())

    return result

def call_gemini(prompt: dict) -> dict:
    """
    Replace this with your Gemini API call (sync or HTTP). This is a stub
    that returns a deterministic mock response for local testing.
    """
    # NOTE: Do not include secrets here — use environment variables in your real call.
    # Example return:
    return {
        "credibility_score": 0.78,
        "reasons": [
            "Price deviation vs historical average is moderate",
            "Image meta tags missing",
        ],
        "raw_model_output": {
            "prompt_snapshot": prompt
        }
    }
