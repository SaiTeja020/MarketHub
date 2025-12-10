# backend/python/project/tasks/gemini.py
import os
import json
from datetime import datetime
from typing import Any, Dict

import httpx
import redis  # sync redis client from redis-py
from celery.utils.log import get_task_logger
from celery.exceptions import MaxRetriesExceededError

from utils.celery_app import celery_app

logger = get_task_logger(__name__)

# Env / defaults
GEMINI_ENDPOINT = os.getenv("GEMINI_ENDPOINT", "https://gemini.example/api")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", None)
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

# Helper to write analysis to Redis (two key shapes for compatibility)
def persist_analysis_to_redis(task_id: str, analysis_obj: Dict[str, Any]) -> None:
    """
    Persist analysis in two shapes:
      - HSET scrape:analysis:<task_id> result "<json>"
      - SET analysis:result:<task_id> "<json>"
    This covers both hash-style and simple-get style lookups used across the codebase.
    """
    try:
        r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        payload = json.dumps(analysis_obj, default=str, ensure_ascii=False)
        # Hash style (legacy / node-style)
        try:
            r.hset(f"scrape:analysis:{task_id}", "result", payload)
        except Exception:
            logger.exception("Failed to HSET scrape:analysis:%s", task_id)
        # Simple key style
        try:
            r.set(f"analysis:result:{task_id}", payload)
        except Exception:
            logger.exception("Failed to SET analysis:result:%s", task_id)
    except Exception:
        logger.exception("Failed to connect to Redis at %s", REDIS_URL)
        raise


@celery_app.task(name="gemini.call_gemini", bind=True, max_retries=5, acks_late=True)
def call_gemini(self, payload: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
    """
    Celery task to call Gemini and persist analysis result to Redis.

    Expected payload keys:
      - task_id (str)   : required
      - product_id (str)
      - title (str)
      - image_url (str)
      - current_price (float)

    The worker will call GEMINI_ENDPOINT + '/v1/generate' by default — adjust if your provider uses a different path.
    """
    task_id = payload.get("task_id") or payload.get("id")
    if not task_id:
        raise ValueError("payload must include a 'task_id'")

    if not GEMINI_API_KEY:
        logger.error("GEMINI_API_KEY not set — cannot call Gemini")
        raise RuntimeError("GEMINI_API_KEY not set in environment")

    # Build request shape - adapt to your Gemini provider required payload
    gemini_url = GEMINI_ENDPOINT.rstrip("/") + "/v1/generate"
    headers = {
        "Authorization": f"Bearer {GEMINI_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    # Example prompt body for LLM — adjust / enrich as you need
    request_body = {
        "input": {
            "product_id": payload.get("product_id"),
            "title": payload.get("title"),
            "image_url": payload.get("image_url"),
            "current_price": payload.get("current_price"),
            # you can add more structured fields, user preferences, or system prompt here
        },
        # provider-specific options (temperature, tokens, model, etc.) can go here
    }

    try:
        logger.info("Calling Gemini for task_id=%s product_id=%s", task_id, payload.get("product_id"))
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(gemini_url, json=request_body, headers=headers)
            resp.raise_for_status()
            resp_json = resp.json()
            logger.info("Gemini response received for task_id=%s (len=%d)", task_id, len(json.dumps(resp_json)))
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        logger.exception("Gemini HTTP error status=%s for task=%s", status, task_id)
        # Retry on 429 / 5xx, otherwise fail
        if status == 429 or 500 <= status < 600:
            try:
                countdown = 10 * (self.request.retries + 1)
                raise self.retry(exc=exc, countdown=countdown)
            except MaxRetriesExceededError:
                logger.error("Max retries exceeded for Gemini task %s (HTTPStatusError)", task_id)
                raise
        else:
            raise
    except Exception as exc:
        logger.exception("Unexpected error calling Gemini for task %s: %s", task_id, exc)
        try:
            countdown = 10 * (self.request.retries + 1)
            raise self.retry(exc=exc, countdown=countdown)
        except MaxRetriesExceededError:
            logger.error("Max retries exceeded for Gemini task %s (exception)", task_id)
            raise

    # Build analysis result object to store (you can expand this with derived fields)
    analysis_obj = {
        "task_id": task_id,
        "product_id": payload.get("product_id"),
        "raw_response": resp_json,
        "completed_at": datetime.utcnow().isoformat() + "Z",
        # default credibility_score: worker can attempt a heuristic, but keep safe default 0.5
        "credibility_score": 0.5,
    }

    # OPTIONAL: try to compute a simple credibility score or extraction here
    try:
        # Example heuristic: if resp_json has 'confidence' field use it
        if isinstance(resp_json, dict):
            conf = resp_json.get("confidence") or resp_json.get("meta", {}).get("confidence")
            if isinstance(conf, (int, float)):
                analysis_obj["credibility_score"] = float(conf)
    except Exception:
        # non-fatal — keep default
        logger.debug("Could not compute credibility_score heuristics for task %s", task_id)

    # Persist into Redis (two key shapes)
    try:
        persist_analysis_to_redis(task_id, analysis_obj)
        logger.info("Persisted analysis for task_id=%s to Redis", task_id)
    except Exception as exc:
        logger.exception("Failed to persist analysis for task %s: %s", task_id, exc)
        # We persist to Redis as the canonical completion signal. If persist failed, consider retry.
        try:
            raise self.retry(exc=exc, countdown=10 * (self.request.retries + 1))
        except MaxRetriesExceededError:
            logger.error("Max retries exceeded while trying to persist analysis for %s", task_id)
            raise

    # Optionally return the analysis object (will be stored in result backend if configured)
    return analysis_obj
