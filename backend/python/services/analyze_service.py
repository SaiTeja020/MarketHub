# backend/python/services/analyze_service.py
import os
import json
import time
import logging
import re
from typing import Any, Dict, List, Optional

import httpx
from datetime import datetime, timedelta

from utils.redis_client import get_redis
from services.deal_service import compute_deal_score, generate_summary
from services.elastic_service import get_es, PRICE_HISTORY_INDEX

logger = logging.getLogger("services.analyze_service")
logger.setLevel(logging.INFO)

GEMINI_API_URL = os.getenv("GEMINI_API_URL")  # e.g. "https://api.example.com/v1/generate"
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
# how many historical entries to fetch for analysis (tuneable)
HIST_LOOKBACK = int(os.getenv("ANALYZE_HIST_LOOKBACK", "180"))

# Redis TTL for analysis result (seconds)
ANALYSIS_TTL = int(os.getenv("ANALYSIS_RESULT_TTL", str(60 * 60 * 24)))  # 1 day

# Basic HTTPX client
_client = httpx.Client(timeout=15.0)


def _strip_code_fence(s: str) -> str:
    """Remove surrounding code fences or markdown wrappers."""
    if not s:
        return s
    # strip triple backticks and language hint
    s = re.sub(r"^```[a-zA-Z0-9+\-_.]*\n", "", s)
    s = re.sub(r"\n```$", "", s)
    # sometimes returned inside single-line backticks
    s = s.strip().strip("`")
    return s.strip()


def _extract_json_from_text(s: str) -> Optional[str]:
    """
    Try to find the first JSON object in a text blob.
    Returns JSON substring or None.
    """
    if not s:
        return None
    # strip code fences first
    s2 = _strip_code_fence(s)

    # naive attempt: find {...} balanced braces
    start = s2.find("{")
    if start == -1:
        return None

    # attempt to find matching brace (balance)
    depth = 0
    for i in range(start, len(s2)):
        if s2[i] == "{":
            depth += 1
        elif s2[i] == "}":
            depth -= 1
            if depth == 0:
                candidate = s2[start : i + 1]
                return candidate
    # fallback: try to parse the whole stripped string
    return s2


def _call_gemini(prompt: str, timeout: int = 12) -> Optional[str]:
    """
    Call Gemini-like API. Adjust payload depending on actual API.
    Returns raw text response (string) or None on error.
    """
    if not GEMINI_API_URL or not GEMINI_API_KEY:
        logger.warning("GEMINI_API_URL or GEMINI_API_KEY not configured")
        return None

    headers = {
        "Authorization": f"Bearer {GEMINI_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    # Default body — if your Gemini API expects different fields, change here.
    body = {
        "prompt": prompt,
        "max_tokens": 300,
        "temperature": 0.0,
    }

    try:
        resp = httpx.post(GEMINI_API_URL, json=body, headers=headers, timeout=timeout)
        resp.raise_for_status()
        # Try json first (some APIs return { "text": "..."} ), otherwise text.
        try:
            j = resp.json()
            # heuristics: find a text-like field
            if isinstance(j, dict):
                # common locations
                for k in ("text", "output", "generated_text", "result"):
                    if k in j and isinstance(j[k], str):
                        return j[k]
                # sometimes choices array
                if "choices" in j and isinstance(j["choices"], list) and j["choices"]:
                    c0 = j["choices"][0]
                    if isinstance(c0, dict):
                        for k in ("text", "message", "output"):
                            if k in c0 and isinstance(c0[k], str):
                                return c0[k]
                    if isinstance(c0, str):
                        return c0
                # fallback to stringify
                return json.dumps(j)
        except Exception:
            # not JSON — return text
            return resp.text
    except Exception as e:
        logger.exception("Gemini API call failed: %s", e)
        return None


async def _fetch_historical_prices(product_id: str, limit: int = HIST_LOOKBACK) -> List[float]:
    """
    Query Elasticsearch price history index for this product_id and return numeric price list sorted ascending by time.
    """
    try:
        es = await get_es()
        body = {
            "size": limit,
            "query": {"term": {"product_id": product_id}},
            "sort": [{"scraped_at": {"order": "asc"}}],
        }
        resp = await es.search(index=PRICE_HISTORY_INDEX, body=body)
        hits = resp.get("hits", {}).get("hits", [])
        prices = []
        for h in hits:
            src = h.get("_source", {})
            p = src.get("price") or src.get("current_price") or src.get("value") or src.get("amount")
            try:
                if p is None:
                    continue
                pnum = float(p)
                prices.append(pnum)
            except Exception:
                continue
        return prices
    except Exception as e:
        logger.exception("Failed to fetch price history for %s: %s", product_id, e)
        return []


def _build_prompt(title: str, product_id: str, current_price: Optional[float], avg_p: Optional[float], min_p: Optional[float], n_hist: int) -> str:
    """
    Build a clear prompt. Use explicit numeric or 'null' for missing values to avoid 'None' in prompt.
    """
    cur = f"{float(current_price):.2f}" if current_price is not None else "null"
    avg = f"{float(avg_p):.2f}" if avg_p is not None else "null"
    mn = f"{float(min_p):.2f}" if min_p is not None else "null"
    prompt = (
        f"You are a deals analyst. Given product '{title}' (id={product_id}), "
        f"current_price={cur}, historical_average={avg}, historical_min={mn}, history_count={n_hist}.\n\n"
        "Return a JSON object ONLY (no prose) with these fields:\n"
        "- score: integer (0-100) where higher means better deal\n"
        "- credibility_score: number between 0.0 and 1.0 estimating dataset/retailer credibility\n"
        "- summary: a short (1-2 sentence) plain-English summary describing how good the deal is.\n\n"
        "Be concise and factual. If values are missing, use best-effort heuristics. Example:\n"
        '{\"score\": 78, \"credibility_score\":0.85, \"summary\":\"Price is 20% below 30-day average; this looks like a good deal.\"}\n\n'
        "Respond with the JSON only."
    )
    return prompt


async def request_analysis(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Perform analysis for a given payload and persist result in Redis under key analyze:result:<task_id>.
    payload must include: task_id (string), product_id (string). Optional: title, current_price, image_url.
    Returns the analysis dict (same as what's saved).
    """
    task_id = payload.get("task_id") or payload.get("taskId") or payload.get("id")
    product_id = payload.get("product_id") or payload.get("productId")
    title = payload.get("title", "") or ""
    current_price = payload.get("current_price")
    if current_price is None:
        # try alternate keys
        current_price = payload.get("price") or payload.get("value")

    if not task_id or not product_id:
        raise ValueError("request_analysis payload must include task_id and product_id")

    # 1) gather history
    hist_prices = []
    try:
        hist_prices = await _fetch_historical_prices(product_id, limit=HIST_LOOKBACK)
    except Exception:
        hist_prices = []

    n_hist = len(hist_prices)
    avg_p = float(sum(hist_prices) / n_hist) if n_hist else None
    min_p = float(min(hist_prices)) if n_hist else None

    # 2) build prompt and call LLM
    prompt = _build_prompt(title=title or product_id, product_id=product_id, current_price=current_price, avg_p=avg_p, min_p=min_p, n_hist=n_hist)
    logger.info("Analyze: calling Gemini for task=%s product=%s", task_id, product_id)

    # call LLM (synchronous HTTP call)
    llm_resp_text = _call_gemini(prompt)

    parsed = None
    if llm_resp_text:
        try:
            candidate = _extract_json_from_text(llm_resp_text)
            if candidate:
                parsed = json.loads(candidate)
                logger.info("Analyze: parsed LLM JSON for task=%s", task_id)
        except Exception as e:
            logger.warning("Analyze: failed to parse LLM JSON for task=%s: %s. raw=%s", task_id, e, llm_resp_text[:400])

    # 3) Validate LLM result; fallback to local heuristic if invalid
    analysis_obj: Dict[str, Any] = {}
    if parsed and isinstance(parsed, dict):
        try:
            score = int(parsed.get("score", parsed.get("score_percent", parsed.get("score_pct", 0))))
            credibility_score = float(parsed.get("credibility_score", parsed.get("credibility", 0.5)))
            summary = str(parsed.get("summary", parsed.get("text", "") or "")).strip()
            # clamp
            score = max(0, min(100, score))
            credibility_score = max(0.0, min(1.0, credibility_score))
            if not summary:
                summary = parsed.get("summary") or parsed.get("text") or ""
            analysis_obj = {
                "score": score,
                "credibility_score": credibility_score,
                "summary": summary,
                "source": "gemini"
            }
        except Exception as e:
            logger.warning("Analyze: LLM response validation failed: %s", e)
            parsed = None

    if not parsed:
        # fallback: local heuristic
        cred = 0.5
        score_local = compute_deal_score(float(current_price) if current_price is not None else None or 0.0, hist_prices, cred)
        avg_for_summary = avg_p or 0.0
        min_for_summary = min_p or 0.0
        summary_lines = generate_summary(float(current_price) if current_price is not None else 0.0, avg_for_summary, min_for_summary, cred)
        analysis_obj = {
            "score": int(score_local),
            "credibility_score": cred,
            "summary": " ".join(summary_lines[:2]) if isinstance(summary_lines, list) else str(summary_lines),
            "source": "local-fallback"
        }
        logger.info("Analyze: used local fallback for task=%s", task_id)

    # 4) Add metadata
    analysis_obj.update({
        "task_id": task_id,
        "product_id": product_id,
        "title": title,
        "current_price": current_price,
        "historical_count": n_hist,
        "historical_avg": avg_p,
        "historical_min": min_p,
        "completed_at": datetime.utcnow().isoformat() + "Z",
        "raw_llm": llm_resp_text[:400] if llm_resp_text else None
    })

    # 5) persist into Redis
    try:
        r = await get_redis()
        key = f"analyze:result:{task_id}"
        await r.set(key, json.dumps(analysis_obj))
        try:
            await r.expire(key, ANALYSIS_TTL)
        except Exception:
            pass
    except Exception as e:
        logger.exception("Analyze: failed to save result to Redis for task=%s: %s", task_id, e)

    return analysis_obj


async def get_analysis_result(task_id: str) -> Optional[Dict[str, Any]]:
    """
    Fetch analysis result from Redis if present.
    """
    try:
        r = await get_redis()
        raw = await r.get(f"analyze:result:{task_id}")
        if not raw:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return json.loads(raw)
    except Exception as e:
        logger.exception("get_analysis_result error for %s: %s", task_id, e)
        return None
