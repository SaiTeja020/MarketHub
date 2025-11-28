# api/main.py

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, HttpUrl
from utils.redis_client import get_redis
import httpx
import uuid
import os

from services.analyze_service import request_analysis, get_analysis_result

NODE_SCRAPER_URL = os.getenv("NODE_SCRAPER_URL", "http://node_app:5000")

app = FastAPI(
    title="MarketHub API",
    description="Coordinator API for scraping, analysis, and indexing",
    version="1.0.0"
)

# -------------------------------
# Request Models
# -------------------------------

class ScrapeRequest(BaseModel):
    url: HttpUrl
    source: str  # "amazon", "flipkart", etc.


class AnalyzeRequest(BaseModel):
    product_id: str
    title: str | None = None
    image_url: HttpUrl | None = None
    current_price: float | None = None


# -------------------------------
# Scraping Endpoints (Handled by Node)
# -------------------------------

@app.post("/scrape", status_code=202)
async def enqueue_scrape_job(req: ScrapeRequest):
    """
    FastAPI does NOT scrape.
    It forwards scrape requests to the Node backend.
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
    Fetch the scraping result from Redis.
    Node worker writes into: scrape:result:{task_id}
    """
    redis = await get_redis()
    data = await redis.get(f"scrape:result:{task_id}")

    if not data:
        raise HTTPException(
            status_code=404,
            detail="Scraping result not ready"
        )

    import json
    return {
        "task_id": task_id,
        "result": json.loads(data)
    }


# -------------------------------
# Analysis Endpoints (Gemini via Celery)
# -------------------------------

@app.post("/analyze", status_code=202)
async def enqueue_analysis(req: AnalyzeRequest):
    """
    Sends scraping result to Celery for Gemini analysis.
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
    Reads the analysis result from Redis.
    """
    result = await get_analysis_result(task_id)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail="Analysis result not ready"
        )

    return {
        "task_id": task_id,
        "analysis": result
    }


# -------------------------------
# Health Check
# -------------------------------

@app.get("/")
def root():
    return {
        "service": "MarketHub API",
        "status": "running",
        "message": "Use /scrape or /analyze endpoints"
    }
