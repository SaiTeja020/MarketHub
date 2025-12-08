# services/analyze_service.py
import asyncio
import json
import logging
from typing import Optional

from services.deal_service import compute_deal_score, generate_summary
from services.elastic_service import get_es, PRICE_HISTORY_INDEX
from utils.redis_client import get_redis

logger = logging.getLogger("services.analyze_service")


async def _compute_and_store(payload: dict):
    """
    Background worker that builds a quick analysis result and stores it in redis.
    This is a fallback/smoke-test implementation so the frontend can show analysis
    immediately without an external LLM worker.
    """
    try:
        task_id = payload.get("task_id")
        product_id = payload.get("product_id")
        current_price = payload.get("current_price")

        # Default credibility (we don't have LLM here) - will be replaced by real Gemini results later
        credibility_score = 0.7

        # Try to read price history from ES (best-effort). If ES fails, continue with empty list.
        historical_prices = []
        try:
            es = await get_es()
            # fetch up to 1000 history rows
            hist_resp = await es.search(
                index=PRICE_HISTORY_INDEX,
                body={
                    "size": 1000,
                    "query": {"term": {"product_id": product_id}},
                    "sort": [{"scraped_at": {"order": "asc"}}],
                },
            )
            hits = hist_resp.get("hits", {}).get("hits", [])
            for h in hits:
                src = h.get("_source", {}) if isinstance(h, dict) else {}
                p = src.get("price") or src.get("current_price") or src.get("value") or src.get("amount")
                try:
                    if p is not None:
                        # coerce to float if possible
                        val = float(p)
                        historical_prices.append(val)
                except Exception:
                    continue
        except Exception as e:
            logger.debug("Could not fetch price history from ES: %r", e)

        # Compute avg/min if available
        avg_p = sum(historical_prices) / len(historical_prices) if historical_prices else (current_price or 0)
        min_p = min(historical_prices) if historical_prices else (current_price or 0)
        n_hist = len(historical_prices)

        # Compute simple score using existing deal_service
        score = compute_deal_score(float(current_price or 0), historical_prices, float(credibility_score or 0.5))

        # Build a short summary (1-2 sentences)
        summary_lines = generate_summary(float(current_price or 0), avg_p, min_p, float(credibility_score or 0.5))
        summary = " ".join(summary_lines[:2])  # keep it short

        analysis = {
            "score": int(score),
            "credibility_score": float(credibility_score),
            "summary": summary,
            # include some diagnostics so frontend / logs can show helpful info
            "meta": {"product_id": product_id, "n_history": n_hist, "avg_price": avg_p, "min_price": min_p},
        }

        # Store into redis so GET /analyze/result will find it
        redis = await get_redis()
        key = f"analysis:result:{task_id}"
        await redis.set(key, json.dumps(analysis), ex=60 * 60)  # 1 hour TTL

        logger.info("Stored analysis result for task %s (n_history=%d)", task_id, n_hist)
    except Exception as e:
        logger.exception("Failed to compute/store analysis for payload %r: %s", payload, e)


def request_analysis(payload: dict):
    """
    Non-async entrypoint called by the API to request an analysis.
    We schedule an async background task that computes and writes the result to Redis.
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(_compute_and_store(payload))
        else:
            # fallback - run until complete
            asyncio.run(_compute_and_store(payload))
    except RuntimeError:
        # No running event loop (shouldn't happen with FastAPI running) - run sync
        asyncio.run(_compute_and_store(payload))


async def get_analysis_result(task_id: str) -> Optional[dict]:
    """
    Read analysis result from Redis (if present). Return parsed object or None.
    """
    try:
        redis = await get_redis()
        raw = await redis.get(f"analysis:result:{task_id}")
        if not raw:
            return None
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8")
        return json.loads(raw)
    except Exception as e:
        logger.exception("Error reading analysis result for %s: %s", task_id, e)
        return None
