# api/main.py

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, HttpUrl
import uuid

from services.scrape_service import publish_scrape_job, fetch_result
from services.analyze_service import request_analysis, get_analysis_result

app = FastAPI(
    title="MarketHub API",
    description="Microservice architecture with RabbitMQ, Redis, and Celery",
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
# Scraping Endpoints
# -------------------------------

@app.post("/scrape", status_code=202)
async def enqueue_scrape_job(req: ScrapeRequest):
    """
    Publishes a scraping job to RabbitMQ.
    The scraper worker (separate process) will consume, scrape,
    and then write the result to Redis.
    """
    task_id = str(uuid.uuid4())

    payload = {
        "task_id": task_id,
        "url": str(req.url),
        "source": req.source.lower()
    }

    try:
        await publish_scrape_job(req.source, payload)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to publish scrape job: {e}"
        )

    return {
        "task_id": task_id,
        "status": "queued",
        "message": f"Scrape job for {req.source} published successfully"
    }


@app.get("/scrape/result/{task_id}")
async def get_scrape_result(task_id: str):
    """
    Fetches the scraping result from Redis.
    Returns 404 if the result hasn't been written yet.
    """
    result = await fetch_result(task_id)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail="Scraping result not ready"
        )

    return {
        "task_id": task_id,
        "result": result
    }


# -------------------------------
# Analysis Endpoints (Gemini via Celery)
# -------------------------------

@app.post("/analyze", status_code=202)
async def enqueue_analysis(req: AnalyzeRequest):
    """
    Creates a Celery task that performs Gemini analysis.
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
        request_analysis.delay(payload)  # send to Celery
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
