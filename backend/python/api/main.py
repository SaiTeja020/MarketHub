# api/main.py
import os
import uuid
import json
import logging
import asyncio

from datetime import datetime
from urllib.parse import unquote
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl

from utils.redis_client import get_redis
from utils.rabbit_publish import publish_scrape_job
from services.analyze_service import request_analysis, get_analysis_result
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
    """
    Robust dashboard endpoint that supports multiple data shapes:
      - user_products index storing one doc per user with `products: [{product_id, added_at}, ...]`
      - or user_products index storing multiple docs each with `product_id`
      - fallback to PRODUCT_INDEX docs that include `user_id` (legacy)
    It then mgets canonical product docs from PRODUCT_INDEX and collects normalized price_history.
    """
    es = await get_es()
    logger.info("DASHBOARD request for user_id=%s", user_id)

    products = []
    product_ids = []

    # helper to check index existence
    async def index_exists(idx_name: str) -> bool:
        try:
            return bool(await es.indices.exists(index=idx_name))
        except Exception:
            return False

    # 1) Prefer user_products index (if present)
    if await index_exists("user_products"):
        try:
            # try to find a direct doc with user_id as id (common for single-doc-per-user)
            try:
                up_get = await es.get(index="user_products", id=user_id)
                up_doc = up_get.get("_source")
                if up_doc:
                    logger.info("DASHBOARD: found user_products doc by id for user %s", user_id)
                    # extract product ids from up_doc.products array if present
                    if isinstance(up_doc.get("products"), list):
                        product_ids = [p.get("product_id") for p in up_doc["products"] if p.get("product_id")]
                else:
                    product_ids = []
            except Exception:
                # not found by id — fallback to search by user_id field
                user_prod_resp = await es.search(index="user_products", body={
                    "size": 1000,
                    "query": {"term": {"user_id.keyword": user_id}}
                })
                hits = user_prod_resp.get("hits", {}).get("hits", [])
                logger.info("DASHBOARD: user_products search hits=%d", len(hits))
                # two shapes possible: hits with _source.product_id OR _source.products array
                ids = []
                for h in hits:
                    src = h.get("_source", {})
                    if src.get("product_id"):
                        ids.append(src.get("product_id"))
                    elif isinstance(src.get("products"), list):
                        ids.extend([p.get("product_id") for p in src["products"] if p.get("product_id")])
                product_ids = ids
        except Exception as e:
            logger.exception("DASHBOARD: error reading user_products: %s", e)
            product_ids = []

    # 2) If still empty, fall back to PRODUCT_INDEX by user_id (legacy)
    if not product_ids:
        try:
            prod_resp = await es.search(index=PRODUCT_INDEX, body={
                "size": 200,
                "query": {"term": {"user_id.keyword": user_id}}
            })
            prod_hits = prod_resp.get("hits", {}).get("hits", [])
            logger.info("DASHBOARD: PRODUCT_INDEX hits=%d", len(prod_hits))
            # collect product source docs (if they already store the canonical metadata)
            products = [h.get("_source") for h in prod_hits if h.get("_source")]
            product_ids = [p.get("product_id") for p in products if p.get("product_id")]
        except Exception as e:
            logger.exception("DASHBOARD: error searching PRODUCT_INDEX by user_id: %s", e)
            products = []
            product_ids = []

    # 3) If product_ids were found via user_products but we don't yet have products, mget canonical docs
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

    # If still no product_ids, return empty result
    if not product_ids:
        logger.info("DASHBOARD: no product ids found for user %s", user_id)
        return {"products": products, "price_history": []}

    # 4) Fetch price history for discovered product_ids (normalize afterwards)
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

    # 5) Normalize price history rows
    normalized = []
    for src in raw_price_hits:
        r = dict(src or {})
        # price
        price = r.get("price")
        if price is None:
            price = r.get("current_price") or r.get("value") or r.get("amount") or None

        # scraped_at
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

    # 6) Sort ascending by scraped_at (unknown dates go last)
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
    Send scraping result to Celery for Gemini analysis.
    """
    task_id = str(uuid.uuid4())

    payload = {
        "task_id": task_id,
        "product_id": req.product_id,
        "title": req.title,
        "image_url": str(req.image_url) if req.image_url else None,
        "current_price": req.current_price
    }

    try:
        request_analysis(payload)
    except Exception as e:
        logger.exception("Failed to queue analysis job: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to queue analysis job: {e}")

    return {
        "task_id": task_id,
        "status": "queued",
        "message": "Analysis job sent to Celery"
    }


@app.get("/analyze/result/{task_id}")
async def get_analysis_result_endpoint(task_id: str):
    """
    Fetch LLM analysis from Redis AND index into Elasticsearch.
    """
    analysis = await get_analysis_result(task_id)

    if analysis is None:
        raise HTTPException(status_code=404, detail="Analysis result not ready")

    try:
        await index_analysis_result(task_id, analysis)
    except Exception as e:
        logger.exception("Failed to index analysis result %s: %s", task_id, e)
        raise HTTPException(status_code=500, detail=f"Failed to index analysis: {e}")

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
    """
    Returns product metadata list belonging to a specific user.
    Supports multiple shapes in user_products index:
      - single doc with id == user_id and _source.products = [{product_id, added_at}, ...]
      - multiple docs with _source.product_id and user_id field
    Will mget canonical product docs from PRODUCT_INDEX if available.
    """
    es = await get_es()
    products = []

    try:
        # 1) Try get by id (single-doc-per-user pattern)
        try:
            up_get = await es.get(index="user_products", id=user_id)
            up_src = up_get.get("_source") or {}
            product_ids = []
            if isinstance(up_src.get("products"), list):
                product_ids = [p.get("product_id") for p in up_src["products"] if p.get("product_id")]
            else:
                # fall back to legacy single docs pattern
                if up_src.get("product_id"):
                    product_ids = [up_src.get("product_id")]
        except Exception:
            # not found by id -> search user_products by user_id field
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
                # ignore and continue to fallback below
                product_ids = []

        # 2) If we have product_ids, fetch canonical product docs from PRODUCT_INDEX
        if product_ids:
            dedup = list(dict.fromkeys([pid for pid in product_ids if pid]))
            if dedup:
                mget_resp = await es.mget(body={"ids": dedup}, index=PRODUCT_INDEX)
                docs = mget_resp.get("docs", [])
                products = [d.get("_source") for d in docs if d.get("found") and d.get("_source")]
        else:
            # 3) As a last resort, search PRODUCT_INDEX for docs with user_id (legacy)
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
