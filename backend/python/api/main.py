# backend/python/api/main.py
import os
import uuid
import json
import logging
import asyncio

from datetime import datetime
from urllib.parse import unquote
from typing import Optional, Dict, Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl

from utils.redis_client import get_redis
from utils.rabbit_publish import publish_scrape_job
from services.analyze_service import get_analysis_result
from utils.celery_app import celery_app
from services.elastic_service import (
    ensure_indices,
    close_es,
    index_scraped_product,
    index_analysis_result,
    index_price_history,
    search_products,
    get_es,
    PRODUCT_INDEX,
    ANALYSIS_INDEX,
    PRICE_HISTORY_INDEX,
)

from services.deal_service import compute_deal_score, generate_summary
from elasticsearch import NotFoundError

# --- App & logging setup ---
app = FastAPI(
    title="MarketHub API",
    description="Coordinator API for scraping, Gemini analysis, and Elasticsearch indexing",
    version="1.1.0",
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("fastapi.main")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Important: default should match the node service / port in docker-compose.
NODE_SCRAPER_URL = os.getenv("NODE_SCRAPER_URL", "http://node_app:4000").rstrip("/")

# -------------------------------
# Models
# -------------------------------

class ScrapeRequest(BaseModel):
    url: HttpUrl
    source: str


class AnalyzeRequest(BaseModel):
    product_id: str
    title: Optional[str] = None
    image_url: Optional[HttpUrl] = None
    current_price: Optional[float] = None


class TrackProductRequest(BaseModel):
    user_id: str
    product_id: str
    title: Optional[str] = None
    image_url: Optional[str] = None
    url: Optional[str] = None
    source: Optional[str] = None
    current_price: Optional[float] = None


# -------------------------------
# Normalization helpers
# -------------------------------
# Add this near the top of backend/python/project/tasks/gemini.py (after imports)

import redis  # you already import this elsewhere; keep only one import

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

def persist_analysis_to_redis(task_id: str, analysis_obj: dict) -> None:
    """
    Synchronous persist helper for Celery worker.

    Writes two keys:
      - HSET scrape:analysis:<task_id> result "<json>"
      - SET  analysis:result:<task_id> "<json>"
    so both legacy and new readers can find it.
    """
    try:
        r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    except Exception:
        # if Redis isn't available this will raise; caller can decide to log/retry
        raise

    payload = json.dumps(analysis_obj, default=str, ensure_ascii=False)

    try:
        # legacy hash-style
        r.hset(f"scrape:analysis:{task_id}", "result", payload)
    except Exception:
        # best-effort: log but keep trying to set the simple key
        try:
            # optional: r.hset may not exist on some clients; ignore errors
            pass
        except Exception:
            pass

    try:
        r.set(f"analysis:result:{task_id}", payload)
    except Exception:
        # last-resort: log and re-raise if you want to fail
        pass

def normalize_analysis_for_api(analysis: Any) -> Dict[str, Any]:
    """
    Return a plain dict with keys:
      - score (0..100 float)
      - summary (string)
      - raw_response (JSON-serializable or string)
    This function is defensive against:
      - strings stored in Redis
      - httpx.Response-like objects
      - numeric score in 0..1 or 0..100
    """
    if analysis is None:
        return None

    # If it's a JSON string stored in redis, parse it
    if isinstance(analysis, str):
        try:
            analysis = json.loads(analysis)
        except Exception:
            analysis = {"raw": analysis}

    if not isinstance(analysis, dict):
        # fall back
        try:
            return {"summary": str(analysis), "score": 0.0, "raw_response": str(analysis)}
        except Exception:
            return {"summary": "Invalid analysis format", "score": 0.0}

    # Make a shallow copy to avoid mutating original
    out = dict(analysis)

    # Normalize raw_response if it's an httpx.Response-like or non-serializable
    raw = out.get("raw_response") or out.get("response") or None
    if raw is not None and not isinstance(raw, (dict, list, str, int, float, bool, type(None))):
        try:
            if hasattr(raw, "json") and callable(raw.json):
                try:
                    out["raw_response"] = raw.json()
                except Exception:
                    out["raw_response"] = raw.text if hasattr(raw, "text") else str(raw)
            elif hasattr(raw, "text"):
                out["raw_response"] = raw.text
            else:
                out["raw_response"] = str(raw)
        except Exception:
            out["raw_response"] = str(raw)

    # Score extraction
    score = None
    for k in ("score", "score_percent", "credibility_score", "confidence", "credibility"):
        v = out.get(k)
        if v is None:
            continue
        try:
            score = float(v)
            break
        except Exception:
            try:
                # maybe "50%" or "0.5"
                score = float(str(v).strip().rstrip("%"))
                break
            except Exception:
                continue

    if score is None:
        score = 0.0

    # normalize 0..1 -> 0..100
    if 0.0 <= score <= 1.0:
        score = score * 100.0

    out["score"] = float(score)

    # Summary extraction
    summary = out.get("summary") or out.get("text") or None
    if not summary:
        # try nested shapes
        raw_resp = out.get("raw_response")
        if isinstance(raw_resp, dict):
            for k in ("summary", "text", "output", "message", "content"):
                if k in raw_resp and raw_resp[k]:
                    summary = raw_resp[k]
                    break
            # choices
            if not summary:
                if "choices" in raw_resp and isinstance(raw_resp["choices"], list) and raw_resp["choices"]:
                    c0 = raw_resp["choices"][0]
                    summary = c0.get("text") or c0.get("message") or c0.get("content")
        elif isinstance(raw_resp, list):
            try:
                summary = json.dumps(raw_resp)[:1000]
            except Exception:
                summary = str(raw_resp)[:1000]
        else:
            summary = str(raw_resp or "")[:1000]

    out["summary"] = str(summary)

    # Ensure JSON-serializable: convert problematic fields to str
    for k in list(out.keys()):
        try:
            json.dumps(out[k])
        except Exception:
            out[k] = str(out[k])

    return out


def normalize_analysis_obj(analysis: Any) -> Dict[str, Any]:
    """
    A second conservative normalizer that attempts to unwrap common wrappers,
    ensures raw_response is JSON-safe and that score is normalized to 0..100.
    """
    if analysis is None:
        return {}

    # If an object with __dict__ was returned (e.g., AsyncResult wrapper), try extracting
    if hasattr(analysis, "__dict__") and not isinstance(analysis, dict):
        try:
            analysis = dict(getattr(analysis, "__dict__", {}) or {})
        except Exception:
            analysis = {"raw": str(analysis)}

    if not isinstance(analysis, dict):
        try:
            return json.loads(json.dumps(analysis))
        except Exception:
            return {"raw": str(analysis)}

    out = dict(analysis)

    # Normalize raw_response
    raw = out.get("raw_response") or out.get("response") or None
    if raw is not None:
        try:
            if hasattr(raw, "json") and callable(raw.json):
                try:
                    out["raw_response"] = raw.json()
                except Exception:
                    out["raw_response"] = raw.text if hasattr(raw, "text") else str(raw)
            elif hasattr(raw, "text"):
                out["raw_response"] = raw.text
            else:
                json.dumps(raw)
                out["raw_response"] = raw
        except Exception:
            out["raw_response"] = str(raw)

    # Score normalization
    score_candidates = (
        out.get("score"),
        out.get("score_percent"),
        out.get("credibility_score"),
        out.get("confidence"),
        out.get("credibility"),
    )

    chosen = None
    for c in score_candidates:
        if c is None:
            continue
        try:
            chosen = float(c)
            break
        except Exception:
            try:
                chosen = float(str(c).strip().rstrip("%"))
                break
            except Exception:
                continue

    if chosen is None:
        out["score"] = 0.0
    else:
        if 0.0 <= chosen <= 1.0:
            out["score"] = float(chosen) * 100.0
        else:
            out["score"] = float(chosen)

    # Convert any non-serializable fields to str
    for k, v in list(out.items()):
        try:
            json.dumps(v)
        except Exception:
            out[k] = str(v)

    return out


# -------------------------------
# Synchronous Gemini call & persist
# -------------------------------

# Replace your existing call_gemini_sync_and_persist with this updated version

async def call_gemini_sync_and_persist(payload: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
    """
    Try calling GEMINI synchronously from the API. If successful persist
    the analysis into Redis (both HSET and simple SET shapes) and return
    the analysis object. On HTTP errors produce a friendly analysis_obj
    (with 'error' and 'message') and persist it so frontend sees a reason.
    """
    task_id = payload.get("task_id") or payload.get("id")
    if not task_id:
        raise ValueError("payload must include a 'task_id'")

    GEMINI_ENDPOINT = os.getenv("GEMINI_ENDPOINT", "https://generativelanguage.googleapis.com")
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", None)
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not set in environment")

    headers = {"Content-Type": "application/json"}
    # Build two candidate base paths we will try
    model = os.getenv("GGL_MODEL", "models/text-bison-001")

    def build_url(base_version: str):
        # example: https://generativelanguage.googleapis.com/v1/models/text-bison-001:generate?key=XXX
        return f"{GEMINI_ENDPOINT.rstrip('/')}/{base_version}/models/{model}:generate?key={GEMINI_API_KEY}"

    tried_urls = []
    resp_json = None
    last_exc = None

    async with httpx.AsyncClient(timeout=timeout) as client:
        # try primary v1 then fallback to v1beta2
        for version in ("v1", "v1beta2"):
            gemini_url = build_url(version)
            tried_urls.append(gemini_url)
            try:
                request_body = {
                    "prompt": {"text": f"Analyze product {payload.get('title')!r} and produce a short summary and a numeric credibility score (0..1)."},
                    "temperature": 0.2,
                    "maxOutputTokens": 512,
                }
                resp = await client.post(gemini_url, json=request_body, headers=headers)
                resp.raise_for_status()
                try:
                    resp_json = resp.json()
                except Exception:
                    resp_json = {"text": (await resp.aread()).decode("utf-8", errors="replace")}
                break
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                # If 404 try next version; otherwise break and handle below
                status = exc.response.status_code
                if status == 404:
                    # try next fallback
                    continue
                else:
                    # other HTTP errors -> stop trying
                    break
            except Exception as exc:
                last_exc = exc
                break

    # Build a consistent analysis object (success or friendly error)
    if resp_json is not None:
        analysis_obj = {
            "task_id": task_id,
            "product_id": payload.get("product_id"),
            "raw_response": resp_json,
            "completed_at": datetime.utcnow().isoformat() + "Z",
            "credibility_score": 0.5,
        }
        # optional: try to extract confidence if provider puts it in response
        try:
            if isinstance(resp_json, dict):
                conf = resp_json.get("confidence") or resp_json.get("meta", {}).get("confidence")
                if isinstance(conf, (int, float)):
                    analysis_obj["credibility_score"] = float(conf)
        except Exception:
            pass
    else:
        # Build a friendly error analysis object so the frontend shows a message
        err_msg = "Unknown error calling generative model"
        status_code = None
        raw_text = ""
        if isinstance(last_exc, httpx.HTTPStatusError):
            status_code = last_exc.response.status_code
            try:
                raw_text = last_exc.response.text
            except Exception:
                raw_text = str(last_exc)
            err_msg = f"Provider HTTP {status_code}"
        elif last_exc is not None:
            raw_text = str(last_exc)
            err_msg = "Provider call failed: " + str(last_exc)

        # Keep the original attempted URLs in a safe, non-key form for debugging
        safe_urls = []
        for u in tried_urls:
            # mask key param if present
            safe_urls.append(u.split("?key=")[0] if "?key=" in u else u)

        analysis_obj = {
            "task_id": task_id,
            "product_id": payload.get("product_id"),
            "raw_response": {
                "error": err_msg,
                "status_code": status_code,
                "detail": raw_text,
                "attempted_endpoints": safe_urls,
            },
            "completed_at": datetime.utcnow().isoformat() + "Z",
            "credibility_score": 0.0,
            "error": True,
            "error_message": err_msg + (f": {raw_text}" if raw_text else ""),
        }

    # Persist into Redis (best effort) — reuse your persist helper or inline
    try:
        # use your existing helper persist_analysis_to_redis if available
        persist_analysis_to_redis(task_id, analysis_obj)
    except Exception:
        logger.exception("Persist to Redis failed for analysis %s", task_id)

    return analysis_obj


# -------------------------------
# Startup & Shutdown Events
# -------------------------------

@app.on_event("startup")
async def startup_event():
    try:
        await ensure_indices()
    except Exception as e:
        # Log full repr; don't crash startup if ES not ready
        logger.warning("WARNING: ensure_indices() failed at startup: %r", e)


@app.on_event("shutdown")
async def shutdown_event():
    await close_es()


# -------------------------------
# Utility / Debug
# -------------------------------

@app.get("/debug/config")
def debug_config():
    return {"NODE_SCRAPER_URL": NODE_SCRAPER_URL}


# -------------------------------
# User product endpoints
# -------------------------------

@app.post("/user/add_product")
async def add_user_product(req: TrackProductRequest):
    if not req.url:
        raise HTTPException(status_code=400, detail="Missing product url")

    decoded_url = unquote(req.url)
    es = await get_es()

    # 1) Index user tracking doc immediately
    user_doc_id = f"{req.user_id}-{req.product_id}"
    user_doc = {
        "user_id": req.user_id,
        "product_id": req.product_id,
        "title": req.title,
        "url": decoded_url,
        "image_url": req.image_url,
        "source": req.source,
        "current_price": req.current_price,
        "added_at": datetime.utcnow().isoformat(),
    }

    try:
        await es.index(index=PRODUCT_INDEX, id=user_doc_id, document=user_doc)
    except Exception as e:
        logger.exception("Failed to add tracking doc %s: %s", user_doc_id, e)
        raise HTTPException(status_code=500, detail=f"Failed to add product: {e}")

    # 2) Fire-and-forget enqueue into RabbitMQ so worker will scrape
    payload = {
        "task_id": str(uuid.uuid4()),
        "user_id": req.user_id,
        "url": decoded_url,
        "source": (req.source or "unknown").lower(),
        "product_id": req.product_id,
        "added_at": user_doc["added_at"],
    }

    try:
        # schedule background publish without awaiting (do not block response)
        asyncio.create_task(publish_scrape_job(payload))
        scrape_queued = True
    except Exception as e:
        logger.exception("Failed to enqueue scrape job for %s: %s", req.product_id, e)
        scrape_queued = False

    return {"status": "success", "product": user_doc, "scrape_queued": scrape_queued, "task_id": payload["task_id"] if scrape_queued else None}


# -------------------------------
# Scraping Endpoints
# -------------------------------

@app.post("/scrape", status_code=202)
async def enqueue_scrape_job(req: ScrapeRequest):
    """
    Forward a scrape request to the Node scraper over HTTP.
    """
    task_id = str(uuid.uuid4())

    payload = {
        "task_id": task_id,
        "url": str(req.url),
        "source": req.source.lower(),
    }

    node_endpoint = f"{NODE_SCRAPER_URL}/scrape"
    logger.info("ENQUEUE_ATTEMPT node=%s task_id=%s url=%s", node_endpoint, task_id, payload["url"])

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(node_endpoint, json=payload, timeout=30.0)
        except Exception as e:
            logger.exception("ENQUEUE_ERROR: failed to call node scraper: %s", e)
            raise HTTPException(status_code=500, detail=f"Node scraper error: {e}")

    logger.info("ENQUEUE_RESPONSE status=%s body=%s", response.status_code, (response.text or "")[:500])

    if response.status_code != 202:
        raise HTTPException(status_code=500, detail=f"Node scraper failed: {response.status_code} {response.text}")

    return {
        "task_id": task_id,
        "status": "queued",
        "message": "Scrape job forwarded to Node scraper"
    }


@app.get("/scrape/result/{task_id}")
async def get_scrape_result(task_id: str):
    """
    Fetch scraping result from Redis, index product data, and add price history entry.
    """

    redis = await get_redis()

    # Node worker stores the result as a hash: HSET scrape:result:<task_id> result "<json>"
    raw = None
    try:
        # try HGET first (preferred)
        if hasattr(redis, "hGet"):
            raw = await redis.hGet(f"scrape:result:{task_id}", "result")
        elif hasattr(redis, "hget"):
            raw = await redis.hget(f"scrape:result:{task_id}", "result")
        # fallback to GET (legacy)
        if not raw and hasattr(redis, "get"):
            raw = await redis.get(f"scrape:result:{task_id}")
    except Exception as e:
        logger.exception("Redis read error for task %s: %s", task_id, e)
        raise HTTPException(status_code=500, detail=f"Redis error: {e}")

    if not raw:
        raise HTTPException(status_code=404, detail="Scraping result not ready")

    try:
        data = json.loads(raw)
    except Exception as e:
        logger.exception("Failed to parse scrape result JSON for task %s: %s", task_id, e)
        raise HTTPException(status_code=500, detail=f"Failed to parse scrape result: {e}")

    # 1. Index scraped product
    try:
        await index_scraped_product(data)
    except Exception as e:
        logger.exception("Failed to index scraped product for task %s: %s", task_id, e)
        raise HTTPException(status_code=500, detail=f"Failed to index product: {e}")

    # 2. Index price history event
    try:
        await index_price_history(
            product_id=data.get("product_id"),
            price=data.get("current_price"),
            currency=data.get("currency", "INR"),
            source=data.get("source"),
            scraped_at=data.get("scraped_at")
        )
    except Exception as e:
        logger.exception("Failed to index price history for task %s: %s", task_id, e)
        raise HTTPException(status_code=500, detail=f"Failed to index price history: {e}")

    return {"task_id": task_id, "result": data}


# -------------------------------
# Dashboard / product listing / search endpoints
# -------------------------------

@app.get("/dashboard")
async def dashboard_api(user_id: str):
    es = await get_es()
    logger.info("DASHBOARD request for user_id=%s", user_id)

    products = []
    product_ids = []

    async def index_exists(idx_name: str) -> bool:
        try:
            return bool(await es.indices.exists(index=idx_name))
        except Exception:
            return False

    if await index_exists("user_products"):
        try:
            try:
                up_get = await es.get(index="user_products", id=user_id)
                up_doc = up_get.get("_source")
                if up_doc:
                    logger.info("DASHBOARD: found user_products doc by id for user %s", user_id)
                    if isinstance(up_doc.get("products"), list):
                        product_ids = [p.get("product_id") for p in up_doc["products"] if p.get("product_id")]
                else:
                    product_ids = []
            except Exception:
                user_prod_resp = await es.search(index="user_products", body={
                    "size": 1000,
                    "query": {"term": {"user_id.keyword": user_id}}
                })
                hits = user_prod_resp.get("hits", {}).get("hits", [])
                logger.info("DASHBOARD: user_products search hits=%d", len(hits))
                ids = []
                for h in hits:
                    src = h.get("_source", {}) or {}
                    if src.get("product_id"):
                        ids.append(src.get("product_id"))
                    elif isinstance(src.get("products"), list):
                        ids.extend([p.get("product_id") for p in src["products"] if p.get("product_id")])
                product_ids = ids
        except Exception as e:
            logger.exception("DASHBOARD: error reading user_products: %s", e)
            product_ids = []

    if not product_ids:
        try:
            prod_resp = await es.search(index=PRODUCT_INDEX, body={
                "size": 200,
                "query": {"term": {"user_id.keyword": user_id}}
            })
            prod_hits = prod_resp.get("hits", {}).get("hits", [])
            logger.info("DASHBOARD: PRODUCT_INDEX hits=%d", len(prod_hits))
            products = [h.get("_source") for h in prod_hits if h.get("_source")]
            product_ids = [p.get("product_id") for p in products if p.get("product_id")]
        except Exception as e:
            logger.exception("DASHBOARD: error searching PRODUCT_INDEX by user_id: %s", e)
            products = []
            product_ids = []

    if product_ids and not products:
        try:
            dedup_ids = list(dict.fromkeys([pid for pid in product_ids if pid]))
            if dedup_ids:
                mget_resp = await es.mget(body={"ids": dedup_ids}, index=PRODUCT_INDEX)
                docs = mget_resp.get("docs", [])
                products = [d.get("_source") for d in docs if d.get("found")]
                logger.info("DASHBOARD: mget fetched %d product docs", len(products))
        except Exception as e:
            logger.exception("DASHBOARD: error during mget PRODUCT_INDEX: %s", e)
            products = []

    if not product_ids:
        logger.info("DASHBOARD: no product ids found for user %s", user_id)
        return {"products": products, "price_history": []}

    hist_query = {
        "size": 5000,
        "query": {"terms": {"product_id": list(set([pid for pid in product_ids if pid]))}}
    }

    try:
        hist_resp = await es.search(index=PRICE_HISTORY_INDEX, body=hist_query)
        raw_price_hits = [hit.get("_source") for hit in hist_resp.get("hits", {}).get("hits", [])]
        logger.info("DASHBOARD: raw_price_hits=%d", len(raw_price_hits))
    except Exception as e:
        logger.exception("DASHBOARD: error fetching price_history: %s", e)
        raw_price_hits = []

    normalized = []
    for src in raw_price_hits:
        r = dict(src or {})
        price = r.get("price")
        if price is None:
            price = r.get("current_price") or r.get("value") or r.get("amount") or None

        scraped_at = r.get("scraped_at")
        if not scraped_at:
            if r.get("date"):
                scraped_at = f"{r.get('date')}T00:00:00Z"
            else:
                ts = r.get("timestamp") or r.get("ts")
                try:
                    if isinstance(ts, (int, float)):
                        scraped_at = datetime.utcfromtimestamp(ts / (1000.0 if ts > 1e12 else 1.0)).isoformat() + "Z"
                    elif isinstance(ts, str) and ts.isdigit():
                        tnum = float(ts)
                        scraped_at = datetime.utcfromtimestamp(tnum / (1000.0 if tnum > 1e12 else 1.0)).isoformat() + "Z"
                except Exception:
                    scraped_at = None

        normalized.append({
            "product_id": r.get("product_id"),
            "price": price,
            "currency": r.get("currency") or r.get("curr") or "INR",
            "scraped_at": scraped_at,
            **{k: v for k, v in r.items() if k not in ("price", "current_price", "date", "ts", "timestamp", "scraped_at")}
        })

    def _key(it):
        s = it.get("scraped_at")
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else float("inf")
        except Exception:
            return float("inf")

    normalized.sort(key=_key)

    logger.info("DASHBOARD: returning %d products and %d price_history rows", len(products), len(normalized))
    return {"products": products, "price_history": normalized}


# -------------------------------
# Individual product / deal endpoints
# -------------------------------

@app.get("/product/{product_id}")
async def get_product_details(product_id: str):
    es = await get_es()

    try:
        product_resp = await es.get(index=PRODUCT_INDEX, id=product_id)
        product = product_resp["_source"]
    except NotFoundError:
        raise HTTPException(status_code=404, detail=f"Product {product_id} not found in Elasticsearch")

    analysis_query = {
        "size": 1,
        "query": {
            "term": {"product_id": product_id}
        },
        "sort": [
            {"completed_at": {"order": "desc"}}
        ]
    }

    analysis_resp = await es.search(index=ANALYSIS_INDEX, body=analysis_query)
    analysis_hits = analysis_resp["hits"]["hits"]
    analysis = analysis_hits[0]["_source"] if analysis_hits else None

    return {
        "product_id": product_id,
        "scraped_data": product,
        "analysis": analysis
    }


@app.post("/analyze", status_code=202)
async def enqueue_analysis(req: AnalyzeRequest):
    """
    Prefer synchronous analysis call (fast path) — persist and return immediately.
    If sync path fails (no key or provider error), fall back to enqueueing Celery.
    """
    task_id = str(uuid.uuid4())

    payload = {
        "task_id": task_id,
        "product_id": req.product_id,
        "title": req.title,
        "image_url": str(req.image_url) if req.image_url else None,
        "current_price": req.current_price
    }

    # Try sync call first if we have a configured Gemini endpoint/key
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", None)
    GEMINI_ENDPOINT = os.getenv("GEMINI_ENDPOINT", None)
    if GEMINI_API_KEY and GEMINI_ENDPOINT:
        try:
            analysis = await call_gemini_sync_and_persist(payload)
            logger.info("Synchronous analysis done for task %s", task_id)
            # normalize before returning to frontend
            analysis = normalize_analysis_for_api(analysis)
            return {
                "task_id": task_id,
                "status": "done",
                "analysis": analysis
            }
        except Exception as e:
            logger.warning("Synchronous Gemini call failed for %s, falling back to Celery: %s", task_id, e)

    # Fallback: enqueue into Celery (existing behavior)
    try:
        celery_app.send_task(
            name="gemini.call_gemini",
            args=[payload],
            queue="gemini",
            task_id=task_id,
        )
        logger.info("Enqueued gemini task %s for product %s", task_id, req.product_id)
    except Exception as e:
        logger.exception("Failed to queue analysis job via Celery: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to queue analysis job: {e}")

    return {
        "task_id": task_id,
        "status": "queued",
        "message": "Analysis job sent to Celery"
    }


@app.get("/analyze/result/{task_id}")
async def get_analysis_result_endpoint(task_id: str):
    """
    Fetch LLM analysis, looking in this order:
      1) Redis (hash-style scrape:analysis:<task_id> result or simple analysis:result:<task_id>)
      2) Elasticsearch ANALYSIS_INDEX (maybe already indexed)
      3) Celery result backend (if available and ready)
    If found, normalize, index into ES (id=task_id) and return the analysis object.
    """
    analysis = None
    raw = None

    # 1) Try Redis (both shapes)
    try:
        redis = await get_redis()
        # Prefer hash-style (legacy)
        try:
            if hasattr(redis, "hGet"):
                raw = await redis.hGet(f"scrape:analysis:{task_id}", "result")
            elif hasattr(redis, "hget"):
                raw = await redis.hget(f"scrape:analysis:{task_id}", "result")
        except Exception:
            raw = None

        # fallback to simple GET
        if not raw:
            try:
                if hasattr(redis, "get"):
                    raw = await redis.get(f"analysis:result:{task_id}")
            except Exception:
                raw = None

        if raw:
            try:
                analysis = json.loads(raw)
            except Exception:
                analysis = raw
    except Exception as e:
        logger.debug("Redis lookup error for analysis %s: %s", task_id, e)

    # 2) If not in Redis, try Elasticsearch analysis index
    if analysis is None:
        try:
            es = await get_es()
            # try get by id first (analysis may be indexed with id==task_id)
            try:
                resp = await es.get(index=ANALYSIS_INDEX, id=task_id)
                src = resp.get("_source") or {}
                if src:
                    analysis = src
            except Exception:
                # if get fails, try a search by task_id field
                try:
                    search_body = {
                        "size": 1,
                        "query": {"term": {"task_id.keyword": task_id}}
                    }
                    sresp = await es.search(index=ANALYSIS_INDEX, body=search_body)
                    hits = sresp.get("hits", {}).get("hits", [])
                    if hits:
                        analysis = hits[0].get("_source")
                except Exception as se:
                    logger.debug("ES search error for analysis %s: %s", task_id, se)
        except Exception as e:
            logger.debug("Elasticsearch lookup error for analysis %s: %s", task_id, e)

    # 3) Last resort: check Celery result backend (non-blocking)
    if analysis is None:
        try:
            async_result = celery_app.AsyncResult(task_id)
            if async_result.ready():
                res = async_result.result
                if res:
                    analysis = res
        except Exception as e:
            logger.debug("Celery result backend lookup error for %s: %s", task_id, e)

    # Not found anywhere => still not ready
    if analysis is None:
        raise HTTPException(status_code=404, detail="Analysis result not ready")

    # Normalize analysis so frontend always gets a friendly shape
    try:
        analysis = normalize_analysis_for_api(analysis)
    except Exception as e:
        logger.exception("Normalization failed for analysis %s: %s", task_id, e)
        # fallback to second normalizer
        analysis = normalize_analysis_obj(analysis)

    # Ensure we index the analysis into ES (id=task_id) so subsequent reads are fast.
    try:
        await index_analysis_result(task_id, analysis)
    except Exception as e:
        # don't hide the analysis from the frontend if indexing fails; log and continue
        logger.exception("Failed to index analysis result %s: %s", task_id, e)

    return {"task_id": task_id, "analysis": analysis}


@app.get("/deal/{product_id}")
async def deal_summary(product_id: str):
    es = await get_es()

    try:
        product_resp = await es.get(index=PRODUCT_INDEX, id=product_id)
        product = product_resp["_source"]
    except:
        raise HTTPException(status_code=404, detail="Product not found")

    hist_query = {
        "size": 200,
        "query": {"term": {"product_id": product_id}},
        "sort": [{"scraped_at": {"order": "asc"}}]
    }

    hist_resp = await es.search(index=PRICE_HISTORY_INDEX, body=hist_query)
    history = [h["_source"] for h in hist_resp["hits"]["hits"]]

    prices = [p["price"] for p in history] if history else []
    avg_price = sum(prices) / len(prices) if prices else product.get("current_price")
    min_price = min(prices) if prices else product.get("current_price")

    analysis_query = {
        "size": 1,
        "query": {"term": {"product_id": product_id}},
        "sort": [{"completed_at": {"order": "desc"}}]
    }

    analysis_resp = await es.search(index=ANALYSIS_INDEX, body=analysis_query)
    analysis_hits = analysis_resp["hits"]["hits"]
    analysis = analysis_hits[0]["_source"] if analysis_hits else None

    credibility_score = (analysis.get("credibility_score", 0.5) if analysis is not None else 0.5)

    deal_score = compute_deal_score(
        price=product.get("current_price"),
        historical_prices=prices,
        credibility_score=credibility_score
    )

    summary_lines = generate_summary(
        price=product.get("current_price"),
        avg_price=avg_price,
        min_price=min_price,
        credibility_score=credibility_score
    )

    return {
        "product_id": product_id,
        "deal_score": deal_score,
        "summary": summary_lines,
        "scraped_data": product,
        "analysis_data": analysis,
        "price_history": history
    }


@app.get("/products")
async def list_products(
    source: Optional[str] = None,
    sort_by: Optional[str] = None,
    order: str = "desc",
    size: int = 20,
    page: int = 1
):
    es = await get_es()
    from_ = (page - 1) * size

    query = {"match_all": {}}
    if source:
        query = {"term": {"source": source.lower()}}

    if sort_by == "price":
        sort_field = "current_price"
    elif sort_by == "time":
        sort_field = "scraped_at"
    elif sort_by == "score":
        sort_field = "credibility_score"
    else:
        sort_field = "scraped_at"

    body = {
        "size": size,
        "from": from_,
        "query": query,
        "sort": [
            {sort_field: {"order": order}}
        ]
    }

    try:
        resp = await es.search(index=PRODUCT_INDEX, body=body)
        hits = [h["_source"] for h in resp["hits"]["hits"]]

        return {
            "page": page,
            "size": size,
            "total": resp["hits"]["total"]["value"],
            "results": hits
        }
    except Exception as e:
        logger.exception("Failed to fetch products: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to fetch products: {e}")


@app.get("/analytics/{product_id}")
async def analytics_api(product_id: str):
    es = await get_es()

    try:
        product_resp = await es.get(index=PRODUCT_INDEX, id=product_id)
        product = product_resp["_source"]
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Product not found")

    hist_query = {
        "size": 1000,
        "query": {"term": {"product_id": product_id}},
        "sort": [{"scraped_at": {"order": "asc"}}]
    }

    hist_resp = await es.search(index=PRICE_HISTORY_INDEX, body=hist_query)
    price_history = [h["_source"] for h in hist_resp["hits"]["hits"]]

    retailer_prices = []

    return {
        "product": product,
        "price_history": price_history,
        "retailer_prices": retailer_prices
    }


# Health root
@app.get("/")
def root():
    return {
        "service": "MarketHub API",
        "status": "running",
        "message": "Scrape → Analyze → Index pipeline is active"
    }


@app.get("/user/products")
async def get_user_products(user_id: str):
    es = await get_es()
    products = []

    try:
        try:
            up_get = await es.get(index="user_products", id=user_id)
            up_src = up_get.get("_source") or {}
            product_ids = []
            if isinstance(up_src.get("products"), list):
                product_ids = [p.get("product_id") for p in up_src["products"] if p.get("product_id")]
            else:
                if up_src.get("product_id"):
                    product_ids = [up_src.get("product_id")]
        except Exception:
            product_ids = []
            try:
                resp = await es.search(index="user_products", body={
                    "size": 500,
                    "query": {"term": {"user_id.keyword": user_id}}
                })
                hits = resp.get("hits", {}).get("hits", [])
                for h in hits:
                    src = h.get("_source", {}) or {}
                    if src.get("product_id"):
                        product_ids.append(src.get("product_id"))
                    elif isinstance(src.get("products"), list):
                        product_ids.extend([p.get("product_id") for p in src["products"] if p.get("product_id")])
            except Exception:
                product_ids = []

        if product_ids:
            dedup = list(dict.fromkeys([pid for pid in product_ids if pid]))
            if dedup:
                mget_resp = await es.mget(body={"ids": dedup}, index=PRODUCT_INDEX)
                docs = mget_resp.get("docs", [])
                products = [d.get("_source") for d in docs if d.get("found") and d.get("_source")]
        else:
            resp = await es.search(index=PRODUCT_INDEX, body={
                "size": 300,
                "query": {"term": {"user_id.keyword": user_id}},
                "sort": [{"scraped_at": {"order": "desc"}}]
            })
            products = [h.get("_source") for h in resp.get("hits", {}).get("hits", []) if h.get("_source")]

        return {"products": products}
    except Exception as e:
        logger.exception("Failed to fetch user products for user_id=%s: %s", user_id, e)
        raise HTTPException(status_code=500, detail=f"Failed to fetch user products: {e}")
