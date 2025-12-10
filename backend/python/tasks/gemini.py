# backend/python/project/tasks/gemini.py
import os
import json
from datetime import datetime
from typing import Any, Dict, Tuple, Optional

import httpx
import redis  # sync redis client for the persist helper
from celery.utils.log import get_task_logger
from celery.exceptions import MaxRetriesExceededError

from utils.celery_app import celery_app

logger = get_task_logger(__name__)

# Env / defaults
GEMINI_ENDPOINT = os.getenv("GEMINI_ENDPOINT", "https://generativelanguage.googleapis.com")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", None)
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")


def persist_analysis_to_redis(task_id: str, analysis_obj: Dict[str, Any]) -> None:
    """
    Persist analysis in two shapes:
      - HSET scrape:analysis:<task_id> result "<json>"
      - SET analysis:result:<task_id> "<json>"
    Uses synchronous redis client because Celery worker is sync.
    """
    try:
        r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    except Exception:
        logger.exception("Failed to connect to Redis at %s", REDIS_URL)
        raise

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


def _extract_summary_and_score(resp_json: Any) -> Tuple[str, float]:
    """
    Best-effort extraction of a human summary string and a numeric score (0..100)
    from a provider response (resp_json could be dict, list, string).
    Returns (summary_text, score_value)
    """
    score = 0.0
    summary = ""

    try:
        if resp_json is None:
            return summary, score

        # If httpx.Response-like object, try to extract .json() or .text
        if hasattr(resp_json, "json") and callable(getattr(resp_json, "json")):
            try:
                resp_json = resp_json.json()
            except Exception:
                resp_json = getattr(resp_json, "text", str(resp_json))

        # If string, attempt parse as JSON
        if isinstance(resp_json, str):
            try:
                parsed = json.loads(resp_json)
                resp_json = parsed
            except Exception:
                return (resp_json[:2000], 0.0)

        # If dict-like, try common shapes
        if isinstance(resp_json, dict):
            # Candidate summary fields
            for candidate in ("summary", "text", "message", "output", "content", "result"):
                v = resp_json.get(candidate)
                if v:
                    if isinstance(v, (dict, list)):
                        summary = json.dumps(v)[:2000]
                    else:
                        summary = str(v)
                    break

            # Handle lists of choices/candidates
            if not summary:
                if isinstance(resp_json.get("choices"), list) and resp_json["choices"]:
                    c = resp_json["choices"][0]
                    if isinstance(c, dict):
                        summary = c.get("text") or c.get("message") or c.get("content") or json.dumps(c)[:2000]
                    else:
                        summary = str(c)
                elif isinstance(resp_json.get("candidates"), list) and resp_json["candidates"]:
                    c = resp_json["candidates"][0]
                    if isinstance(c, dict):
                        summary = c.get("content") or c.get("text") or json.dumps(c)[:2000]
                    else:
                        summary = str(c)

            # Candidate numeric fields for score
            for candidate in ("score", "score_percent", "credibility_score", "confidence", "credibility"):
                val = resp_json.get(candidate)
                if val is not None:
                    try:
                        num = float(val)
                        score = num
                        break
                    except Exception:
                        try:
                            score = float(str(val).rstrip("%"))
                            break
                        except Exception:
                            continue

            # Some providers put confidence inside meta
            if score == 0.0:
                meta = resp_json.get("meta") or {}
                if isinstance(meta, dict):
                    conf = meta.get("confidence")
                    try:
                        if conf is not None:
                            score = float(conf)
                    except Exception:
                        pass

        # If resp_json is a list fallback to first item
        if not summary and isinstance(resp_json, list) and resp_json:
            first = resp_json[0]
            if isinstance(first, (dict, list)):
                try:
                    summary = json.dumps(first)[:2000]
                except Exception:
                    summary = str(first)
            else:
                summary = str(first)

        # Normalize score: if between 0..1 assume fraction — convert to 0..100
        try:
            if 0.0 <= score <= 1.0:
                score = float(score) * 100.0
            else:
                score = float(score)
        except Exception:
            score = float(score or 0.0)

        if summary and len(summary) > 2000:
            summary = summary[:2000]

    except Exception:
        logger.exception("Failed to extract summary/score from provider response; returning defaults")

    return summary or "", round(float(score or 0.0), 4)


@celery_app.task(name="gemini.call_gemini", bind=True, max_retries=5, acks_late=True)
def call_gemini(self, payload: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
    """
    Celery task: call Gemini (or configured LLM endpoint) and persist analysis to Redis.
    payload expected keys: task_id, product_id, title, image_url, current_price
    """
    task_id = payload.get("task_id") or payload.get("id")
    if not task_id:
        raise ValueError("payload must include a 'task_id'")

    # If API key missing: return a friendly placeholder instead of raising.
    if not GEMINI_API_KEY:
        logger.warning("GEMINI_API_KEY not set for worker; returning placeholder analysis for task %s", task_id)

        placeholder_obj = {
            "task_id": task_id,
            "product_id": payload.get("product_id"),
            "raw_response": {"error": "GEMINI_API_KEY not set"},
            "summary": "Gemini API credits exhausted — using placeholder analysis.",
            "score": 0.0,
            "credibility_score": 0.0,
            "completed_at": datetime.utcnow().isoformat() + "Z",
            "error": True,
            "error_message": "GEMINI_API_KEY not set in worker environment (placeholder returned)",
        }
        try:
            persist_analysis_to_redis(task_id, placeholder_obj)
            logger.info("Persisted placeholder analysis for missing API key for task %s", task_id)
        except Exception:
            logger.exception("Failed to persist placeholder analysis for %s", task_id)
        # return placeholder instead of raising to avoid bubbling errors to front-end
        return placeholder_obj

    # Prepare candidate endpoints and request body
    headers = {"Content-Type": "application/json"}
    model = os.getenv("GGL_MODEL", "models/text-bison-001")

    # Build candidate URLs (we will try v1 then v1beta2)
    def build_url(version: str) -> str:
        return f"{GEMINI_ENDPOINT.rstrip('/')}/{version}/models/{model}:generate?key={GEMINI_API_KEY}"

    tried_urls = []
    resp_json: Optional[Any] = None
    last_exc: Optional[Exception] = None

    # Try Google-style endpoint first (v1 then v1beta2), else fallback to generic provider path
    try:
        if "generativelanguage.googleapis.com" in (GEMINI_ENDPOINT or ""):
            for version in ("v1", "v1beta2"):
                gemini_url = build_url(version)
                tried_urls.append(gemini_url)
                # mask URL for logs (don't include key)
                safe_url = gemini_url.split("?key=")[0] if "?key=" in gemini_url else gemini_url
                logger.info("Attempting Gemini call to %s for task_id=%s", safe_url, task_id)
                request_body = {
                    "prompt": {"text": f"Analyze product {payload.get('title')!r} and produce a short summary and a numeric credibility score (0..1)."},
                    "temperature": 0.2,
                    "maxOutputTokens": 512,
                }
                try:
                    with httpx.Client(timeout=timeout) as client:
                        resp = client.post(gemini_url, json=request_body, headers=headers)
                        resp.raise_for_status()
                        try:
                            resp_json = resp.json()
                        except Exception:
                            resp_json = getattr(resp, "text", str(resp))
                        logger.info("Gemini response OK for task_id=%s (version=%s)", task_id, version)
                        break
                except httpx.HTTPStatusError as exc:
                    last_exc = exc
                    status = exc.response.status_code
                    logger.warning("Gemini HTTPStatusError status=%s for %s (task=%s)", status, safe_url, task_id)
                    # retryable: rate limit or server errors
                    if status == 429 or 500 <= status < 600:
                        try:
                            countdown = 10 * (self.request.retries + 1)
                            raise self.retry(exc=exc, countdown=countdown)
                        except MaxRetriesExceededError:
                            logger.error("Max retries exceeded for Gemini task %s (HTTPStatusError)", task_id)
                            break
                    # for 404 on this version, try next loop iteration (v1beta2)
                    if status == 404:
                        continue
                    # non-retriable otherwise: break and fall through to friendly placeholder
                    break
                except Exception as exc:
                    last_exc = exc
                    logger.exception("Unexpected exception calling Gemini URL %s for task %s: %s", safe_url, task_id, exc)
                    # Retry transient errors via celery retry
                    try:
                        countdown = 10 * (self.request.retries + 1)
                        raise self.retry(exc=exc, countdown=countdown)
                    except MaxRetriesExceededError:
                        logger.error("Max retries exceeded for Gemini task %s (exception)", task_id)
                        break
        else:
            # Generic provider path
            gemini_url = GEMINI_ENDPOINT.rstrip("/") + "/v1/generate"
            tried_urls.append(gemini_url)
            headers["Authorization"] = f"Bearer {GEMINI_API_KEY}"
            request_body = {
                "input": {
                    "product_id": payload.get("product_id"),
                    "title": payload.get("title"),
                    "image_url": payload.get("image_url"),
                    "current_price": payload.get("current_price"),
                }
            }
            safe_url = gemini_url.split("?key=")[0] if "?key=" in gemini_url else gemini_url
            logger.info("Attempting generic Gemini call to %s for task_id=%s", safe_url, task_id)
            try:
                with httpx.Client(timeout=timeout) as client:
                    resp = client.post(gemini_url, json=request_body, headers=headers)
                    resp.raise_for_status()
                    try:
                        resp_json = resp.json()
                    except Exception:
                        resp_json = getattr(resp, "text", str(resp))
                    logger.info("Generic provider response OK for task_id=%s", task_id)
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                status = exc.response.status_code
                logger.warning("Generic provider HTTPStatusError status=%s for %s (task=%s)", status, safe_url, task_id)
                if status == 429 or 500 <= status < 600:
                    try:
                        countdown = 10 * (self.request.retries + 1)
                        raise self.retry(exc=exc, countdown=countdown)
                    except MaxRetriesExceededError:
                        logger.error("Max retries exceeded for Gemini task %s (HTTPStatusError)", task_id)
                # otherwise fallthrough to build friendly placeholder below
            except Exception as exc:
                last_exc = exc
                logger.exception("Unexpected exception calling generic provider %s for task %s: %s", safe_url, task_id, exc)
                try:
                    countdown = 10 * (self.request.retries + 1)
                    raise self.retry(exc=exc, countdown=countdown)
                except MaxRetriesExceededError:
                    logger.error("Max retries exceeded for Gemini task %s (exception)", task_id)

    except Exception as exc_outer:
        # Any unexpected outer exception — record and continue to build friendly analysis result below
        last_exc = exc_outer
        logger.exception("Unhandled exception in call_gemini main flow for task %s: %s", task_id, exc_outer)

    # At this point either resp_json is populated (success) or we must build a placeholder error object
    if resp_json is None:
        # Build friendly placeholder (do NOT raise). Do not leak API key.
        attempted_safe = [u.split("?key=")[0] if "?key=" in u else u for u in tried_urls]
        logger.warning("All provider attempts failed for task %s; returning placeholder analysis. attempted=%s last_exc=%s",
                       task_id, attempted_safe, repr(last_exc))

        resp_json = {
            # Provide a clear summary string so _extract_summary_and_score can pick it up.
            "summary": "Gemini API credits exhausted — using placeholder analysis.",
            "score": 0.0,
            "note": "provider_unavailable",
            "attempted_endpoints": attempted_safe,
            # keep a small debug detail (may contain error message but avoid exposing keys)
            "debug": str(last_exc)[:1000] if last_exc is not None else None
        }

    # parse provider response to summary & numeric score safely
    try:
        summary_text, score_value = _extract_summary_and_score(resp_json)
    except Exception:
        logger.exception("Failed to parse provider response; using defaults for summary/score")
        summary_text, score_value = "Gemini API credits exhausted — using placeholder analysis.", 0.0

    # Normalize credibility_score into 0..1
    try:
        sc = float(score_value or 0.0)
        if 0.0 <= sc <= 1.0:
            credibility = sc
            score_out = sc * 100.0
        else:
            # assume 0..100 -> convert to 0..1 for credibility
            score_out = sc
            credibility = sc / 100.0 if sc != 0 else 0.0
    except Exception:
        score_out = float(score_value or 0.0)
        credibility = score_out / 100.0 if score_out else 0.0

    analysis_obj = {
        "task_id": task_id,
        "product_id": payload.get("product_id"),
        "raw_response": resp_json,
        "summary": summary_text,
        "score": float(score_out),
        "credibility_score": float(credibility),
        "completed_at": datetime.utcnow().isoformat() + "Z",
    }

    # If resp_json had a 'note' or debug info, annotate but keep safe
    if isinstance(resp_json, dict) and resp_json.get("note"):
        analysis_obj["note"] = resp_json.get("note")
    if isinstance(resp_json, dict) and resp_json.get("debug"):
        analysis_obj["debug"] = str(resp_json.get("debug"))

    # Persist analysis to Redis (best-effort)
    try:
        persist_analysis_to_redis(task_id, analysis_obj)
        logger.info("Persisted analysis for task_id=%s to Redis", task_id)
    except Exception as exc:
        logger.exception("Failed to persist analysis for task %s: %s", task_id, exc)
        # do not raise; we still return the analysis_obj so the result backend may have it

    return analysis_obj
