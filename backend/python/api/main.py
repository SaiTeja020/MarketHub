# api/main.py

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, HttpUrl
from utils.redis_client import get_redis
import httpx
import uuid
import os
from urllib.parse import unquote

from services.analyze_service import request_analysis, get_analysis_result
from services.elastic_service import (
    ensure_indices,
    close_es,
    index_scraped_product,
    index_analysis_result,
    index_price_history,
    search_products
)

from services.deal_service import compute_deal_score, generate_summary
from services.elastic_service import PRICE_HISTORY_INDEX, ANALYSIS_INDEX, PRODUCT_INDEX

from services.elastic_service import get_es, PRODUCT_INDEX, ANALYSIS_INDEX
from elasticsearch import NotFoundError
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="MarketHub API",
    description="Coordinator API for scraping, Gemini analysis, and Elasticsearch indexing",
    version="1.1.0"
)

# MUST come after app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "*",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

NODE_SCRAPER_URL = os.getenv("NODE_SCRAPER_URL", "http://node_api:5000")


# -------------------------------
# Models
# -------------------------------

class ScrapeRequest(BaseModel):
    url: HttpUrl
    source: str


class AnalyzeRequest(BaseModel):
    product_id: str
    title: str | None = None
    image_url: HttpUrl | None = None
    current_price: float | None = None

class TrackProductRequest(BaseModel):
    user_id: str
    product_id: str
    title: str | None = None
    image_url: str | None = None
    url: str | None = None
    source: str | None = None
    current_price: float | None = None

@app.post("/user/add_product")
async def add_user_product(req: TrackProductRequest):
    """
    Adds a user-specific product entry into Elasticsearch.
    (Separate from scraped product data)
    """
    decoded_url = unquote(req.url)

    es = await get_es()

    doc = {
        "user_id": req.user_id,
        "product_id": req.product_id,
        "title": req.title,
        "url": decoded_url,
        "image_url": req.image_url,
        "source": req.source,
        "current_price": req.current_price,
        "added_at": req.current_price,
    }

    try:
        await es.index(
            index=PRODUCT_INDEX,
            id=f"{req.user_id}-{req.product_id}",  # avoid clashes
            document=doc
        )
    except Exception as e:
        raise HTTPException(500, f"Failed to add product: {e}")

    return {"status": "success", "product": doc}


# -------------------------------
# Startup & Shutdown Events
# -------------------------------

@app.on_event("startup")
async def startup_event():
    # ensure Elasticsearch indices exist
    await ensure_indices()

@app.on_event("shutdown")
async def shutdown_event():
    await close_es()


# -------------------------------
# Scraping Endpoints
# -------------------------------

@app.post("/scrape", status_code=202)
async def enqueue_scrape_job(req: ScrapeRequest):
    """
    FastAPI does NOT scrape.
    This forwards scrape requests to the Node scraper.
    """
    task_id = str(uuid.uuid4())

    payload = {
        "task_id": task_id,
        "url": str(req.url),
        "source": req.source.lower(),
    }

    # Call Node scraper over HTTP
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                f"{NODE_SCRAPER_URL}/scrape",
                json=payload,
                timeout=30
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Node scraper error: {e}")

    if response.status_code != 202:
        raise HTTPException(
            status_code=500,
            detail=f"Node scraper failed: {response.text}"
        )

    return {
        "task_id": task_id,
        "status": "queued",
        "message": "Scrape job forwarded to Node scraper"
    }

@app.get("/dashboard")
async def dashboard_api(user_id: str):
    """
    Returns:
    - Products tracked by user_id
    - Price history for those products
    """

    es = await get_es()

    # 1) Fetch products filtered by user_id
    product_query = {
        "size": 200,
        "query": {
            "term": {"user_id": user_id}
        },
        "sort": [{"scraped_at": {"order": "desc"}}]
    }

    prod_resp = await es.search(index=PRODUCT_INDEX, body=product_query)
    products = [hit["_source"] for hit in prod_resp["hits"]["hits"]]

    # 2) Fetch price history for all these product IDs
    product_ids = [p["product_id"] for p in products]

    if not product_ids:
        return {"products": [], "price_history": []}

    hist_query = {
        "size": 5000,
        "query": {
            "terms": {"product_id": product_ids}
        },
        "sort": [{"scraped_at": {"order": "asc"}}]
    }

    hist_resp = await es.search(index=PRICE_HISTORY_INDEX, body=hist_query)
    price_history = [hit["_source"] for hit in hist_resp["hits"]["hits"]]

    return {
        "products": products,
        "price_history": price_history
    }


@app.get("/scrape/result/{task_id}")
async def get_scrape_result(task_id: str):
    """
    Fetch scraping result from Redis, index product data,
    and add price history entry.
    """
    redis = await get_redis()
    raw = await redis.get(f"scrape:result:{task_id}")

    if not raw:
        raise HTTPException(status_code=404, detail="Scraping result not ready")

    import json
    data = json.loads(raw)

    # 1. Index scraped product
    try:
        await index_scraped_product(data)
    except Exception as e:
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
        raise HTTPException(status_code=500, detail=f"Failed to index price history: {e}")

    return {"task_id": task_id, "result": data}


# -------------------------------
# Analysis Endpoints
# -------------------------------

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
        raise HTTPException(
            status_code=500,
            detail=f"Failed to queue analysis job: {e}"
        )

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

    # index the analysis result
    try:
        await index_analysis_result(task_id, analysis)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to index analysis: {e}")

    return {"task_id": task_id, "analysis": analysis}


# -------------------------------
# Search Endpoints
# -------------------------------

@app.delete("/user/remove_product/{user_id}/{product_id}")
async def remove_user_product(user_id: str, product_id: str):
    """
    Removes a tracked product document from ES using composite_id.
    """
    es = await get_es()

    doc_id = f"{user_id}-{product_id}"

    try:
        await es.delete(index=PRODUCT_INDEX, id=doc_id)
    except NotFoundError:
        raise HTTPException(404, "Product not found in user list")
    except Exception as e:
        raise HTTPException(500, f"Failed to remove product: {e}")

    return {"status": "removed", "product_id": product_id}


@app.get("/search")
async def search_products_api(q: str, size: int = 10, source: str | None = None):
    """
    Simple full-text search over products.
    """
    try:
        es_resp = await search_products(q, size=size, source_filter=source)
        hits = [h["_source"] for h in es_resp["hits"]["hits"]]
        return {"total": es_resp["hits"]["total"], "results": hits}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {e}")
    
@app.get("/product/{product_id}")
async def get_product_details(product_id: str):
    """
    Return product details merged from:
    - Scraped product document (products index)
    - Latest analysis result (deal_analysis index)
    """

    es = await get_es()

    # 1. Fetch product
    try:
        product_resp = await es.get(index=PRODUCT_INDEX, id=product_id)
        product = product_resp["_source"]
    except NotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"Product {product_id} not found in Elasticsearch"
        )

    # 2. Fetch analysis results (latest)
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

@app.get("/deal/{product_id}")
async def deal_summary(product_id: str):
    es = await get_es()

    # -----------------------------
    # 1. Fetch product data
    # -----------------------------
    try:
        product_resp = await es.get(index=PRODUCT_INDEX, id=product_id)
        product = product_resp["_source"]
    except:
        raise HTTPException(404, "Product not found")

    # -----------------------------
    # 2. Fetch price history
    # -----------------------------
    hist_query = {
        "size": 200,
        "query": {"term": {"product_id": product_id}},
        "sort": [{"scraped_at": {"order": "asc"}}]
    }

    hist_resp = await es.search(index=PRICE_HISTORY_INDEX, body=hist_query)
    history = [h["_source"] for h in hist_resp["hits"]["hits"]]

    prices = [p["price"] for p in history]
    avg_price = sum(prices) / len(prices) if prices else product["current_price"]
    min_price = min(prices) if prices else product["current_price"]

    # -----------------------------
    # 3. Fetch latest analysis
    # -----------------------------
    analysis_query = {
        "size": 1,
        "query": {"term": {"product_id": product_id}},
        "sort": [{"completed_at": {"order": "desc"}}]
    }

    analysis_resp = await es.search(index=ANALYSIS_INDEX, body=analysis_query)
    analysis_hits = analysis_resp["hits"]["hits"]
    analysis = analysis_hits[0]["_source"] if analysis_hits else None

    credibility_score = (
        analysis.get("credibility_score", 0.5)
        if analysis is not None else 0.5
    )

    # -----------------------------
    # 4. Compute final deal score
    # -----------------------------
    deal_score = compute_deal_score(
        price=product["current_price"],
        historical_prices=prices,
        credibility_score=credibility_score
    )

    # -----------------------------
    # 5. Generate summary
    # -----------------------------
    summary_lines = generate_summary(
        price=product["current_price"],
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
    source: str | None = None,
    sort_by: str | None = None,     # "price", "time", "score"
    order: str = "desc",
    size: int = 20,
    page: int = 1
):
    """
    List products from Elasticsearch with optional:
    - filtering by source (amazon/flipkart)
    - sorting (price, scraped_at, credibility_score)
    - pagination
    """

    es = await get_es()

    # Pagination
    from_ = (page - 1) * size

    # Base query
    query = {"match_all": {}}

    if source:
        query = {
            "term": {
                "source": source.lower()
            }
        }

    # Sorting logic
    if sort_by == "price":
        sort_field = "current_price"
    elif sort_by == "time":
        sort_field = "scraped_at"
    elif sort_by == "score":
        # This requires products to be enriched with analysis score or joined later.
        # For now, fallback to scraped_at if not available.
        sort_field = "credibility_score"
    else:
        sort_field = "scraped_at"

    # ES Query
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
        raise HTTPException(status_code=500, detail=f"Failed to fetch products: {e}")

@app.get("/analytics/{product_id}")
async def analytics_api(product_id: str):
    """
    Returns:
    - Product details
    - Full price history
    - Retailer prices (if needed)
    """

    es = await get_es()

    # 1) Fetch product
    try:
        product_resp = await es.get(index=PRODUCT_INDEX, id=product_id)
        product = product_resp["_source"]
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Product not found")

    # 2) Fetch price history
    hist_query = {
        "size": 1000,
        "query": {"term": {"product_id": product_id}},
        "sort": [{"scraped_at": {"order": "asc"}}]
    }

    hist_resp = await es.search(index=PRICE_HISTORY_INDEX, body=hist_query)
    price_history = [h["_source"] for h in hist_resp["hits"]["hits"]]

    # 3) Retailer comparison (if you index them)
    # OPTIONAL: If you do not have retailer index, return empty []
    retailer_prices = []   # or load from ES if available

    return {
        "product": product,
        "price_history": price_history,
        "retailer_prices": retailer_prices
    }

@app.get("/user/products")
async def get_user_products(user_id: str):
    """
    Returns product list belonging to a specific user.
    Lighter version of /dashboard (no price history).
    """
    es = await get_es()

    query = {
        "size": 300,
        "query": {
            "term": {"user_id": user_id}
        },
        "sort": [{"scraped_at": {"order": "desc"}}]
    }

    try:
        resp = await es.search(index=PRODUCT_INDEX, body=query)
        results = [h["_source"] for h in resp["hits"]["hits"]]
        return {"products": results}
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch user products: {e}")

# -------------------------------
# Health Check
# -------------------------------

@app.get("/")
def root():
    return {
        "service": "MarketHub API",
        "status": "running",
        "message": "Scrape → Analyze → Index pipeline is active"
    }
