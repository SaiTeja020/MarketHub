# api/main.py

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, HttpUrl
from utils.redis_client import get_redis
import httpx
import uuid
import os

from services.analyze_service import request_analysis, get_analysis_result
from services.elastic_service import (
    ensure_indices,
    close_es,
    index_scraped_product,
    index_analysis_result,
    index_price_history,
    search_products
)

from services.elastic_service import get_es, PRODUCT_INDEX, ANALYSIS_INDEX
from elasticsearch import NotFoundError

NODE_SCRAPER_URL = os.getenv("NODE_SCRAPER_URL", "http://node_api:5000")

app = FastAPI(
    title="MarketHub API",
    description="Coordinator API for scraping, Gemini analysis, and Elasticsearch indexing",
    version="1.1.0"
)

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
