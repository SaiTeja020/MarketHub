# services/elastic_service.py
"""
Async Elasticsearch service helpers for MarketHub.

Responsibilities:
- Provide a singleton AsyncElasticsearch client
- Ensure product & analysis indices exist (with mappings)
- Index scraped product docs
- Index analysis results (from Celery/Gemini)
- Provide a simple search helper

Usage:
- Call `await ensure_indices()` during app startup (FastAPI startup event)
- Call `await index_scraped_product(product_doc)` when you want to index scraped data
- Call `await index_analysis_result(task_id, analysis_doc)` after analysis completes
- Use `await search_products(q)` for simple product searches
"""

import os
import asyncio
from typing import Optional, List, Dict, Any

from elasticsearch import AsyncElasticsearch, ElasticsearchException, NotFoundError

ELASTIC_URL = os.getenv("ELASTIC_URL", "http://elasticsearch:9200")
PRODUCT_INDEX = os.getenv("PRODUCT_INDEX", "products")
ANALYSIS_INDEX = os.getenv("ANALYSIS_INDEX", "deal_analysis")

_es_client: Optional[AsyncElasticsearch] = None
_es_lock = asyncio.Lock()


async def get_es() -> AsyncElasticsearch:
    """
    Return a singleton AsyncElasticsearch client.
    """
    global _es_client
    if _es_client is None:
        async with _es_lock:
            if _es_client is None:
                _es_client = AsyncElasticsearch(hosts=[ELASTIC_URL])
    return _es_client


# ----------------------
# Index mappings
# ----------------------

PRODUCT_MAPPING = {
    "mappings": {
        "properties": {
            "product_id": {"type": "keyword"},
            "title": {"type": "text", "analyzer": "standard"},
            "url": {"type": "keyword"},
            "source": {"type": "keyword"},
            "current_price": {"type": "double"},
            "currency": {"type": "keyword"},
            "image_url": {"type": "keyword"},
            "metadata": {"type": "object", "enabled": False},  # keep raw
            "scraped_at": {"type": "date"},
            "raw_html": {"type": "text", "index": False}  # store but don't index
        }
    }
}

ANALYSIS_MAPPING = {
    "mappings": {
        "properties": {
            "task_id": {"type": "keyword"},
            "product_id": {"type": "keyword"},
            "credibility_score": {"type": "double"},
            "reasons": {"type": "text"},
            "analysis_payload": {"type": "object", "enabled": False},
            "completed_at": {"type": "date"}
        }
    }
}


# ----------------------
# Ensure indices exist
# ----------------------

async def ensure_index(es: AsyncElasticsearch, index_name: str, mapping: Dict[str, Any]):
    try:
        exists = await es.indices.exists(index=index_name)
        if not exists:
            await es.indices.create(index=index_name, body=mapping)
    except ElasticsearchException as e:
        raise RuntimeError(f"Failed to ensure index {index_name}: {e}") from e


async def ensure_indices():
    """
    Create product and analysis indices if they don't exist.
    Call this in FastAPI startup event:
    @app.on_event("startup")
    async def startup():
        await ensure_indices()
    """
    es = await get_es()
    await ensure_index(es, PRODUCT_INDEX, PRODUCT_MAPPING)
    await ensure_index(es, ANALYSIS_INDEX, ANALYSIS_MAPPING)


# ----------------------
# Indexing helpers
# ----------------------

async def index_scraped_product(product_doc: Dict[str, Any], doc_id: Optional[str] = None, refresh: bool = False):
    """
    Index a scraped product document into PRODUCT_INDEX.
    product_doc should be a JSON-serializable dict. Recommended keys:
    - product_id (preferred) or doc_id (will be used as _id)
    - title, url, source, current_price, image_url, scraped_at, metadata, raw_html

    If doc_id is None, will try to use product_doc.get('product_id'), otherwise let ES generate ID.
    """
    es = await get_es()
    try:
        _id = doc_id or product_doc.get("product_id")
        params = {"index": PRODUCT_INDEX, "document": product_doc}
        if _id:
            params["id"] = _id
        if refresh:
            params["refresh"] = "true"
        resp = await es.index(**params)
        return resp
    except ElasticsearchException as e:
        raise RuntimeError(f"Failed to index product doc: {e}") from e


async def index_analysis_result(task_id: str, analysis_doc: Dict[str, Any], doc_id: Optional[str] = None, refresh: bool = False):
    """
    Index analysis result into ANALYSIS_INDEX.
    analysis_doc typically contains: product_id, credibility_score, reasons, completed_at, raw_model_output.
    """
    es = await get_es()
    try:
        _id = doc_id or task_id
        params = {"index": ANALYSIS_INDEX, "document": analysis_doc}
        if _id:
            params["id"] = _id
        if refresh:
            params["refresh"] = "true"
        resp = await es.index(**params)
        return resp
    except ElasticsearchException as e:
        raise RuntimeError(f"Failed to index analysis doc: {e}") from e


# ----------------------
# Search helper
# ----------------------

async def search_products(query: str, size: int = 10, source_filter: Optional[str] = None) -> Dict[str, Any]:
    """
    Basic full-text search over product title. Returns ES search response.
    """
    es = await get_es()
    body = {
        "size": size,
        "query": {
            "bool": {
                "must": [
                    {"multi_match": {"query": query, "fields": ["title", "metadata.*"]}}
                ]
            }
        }
    }
    if source_filter:
        body["query"]["bool"].setdefault("filter", []).append({"term": {"source": source_filter}})

    try:
        resp = await es.search(index=PRODUCT_INDEX, body=body)
        return resp
    except NotFoundError:
        return {"hits": {"total": 0, "hits": []}}
    except ElasticsearchException as e:
        raise RuntimeError(f"Search failed: {e}") from e


# ----------------------
# Bulk index helper (optional)
# ----------------------

async def bulk_index_products(docs: List[Dict[str, Any]], id_field: str = "product_id", chunk_size: int = 1000):
    """
    Bulk index many product docs. Uses ES bulk API.
    Each doc should be a dict. If id_field exists in doc, it will be used as _id.
    """
    from elasticsearch.helpers import async_bulk  # imported here to avoid import on top if not used
    es = await get_es()

    async def gen_actions():
        for doc in docs:
            action = {
                "_index": PRODUCT_INDEX,
                "_source": doc
            }
            if id_field and id_field in doc:
                action["_id"] = doc[id_field]
            yield action

    try:
        success, errors = await async_bulk(client=es, actions=gen_actions(), chunk_size=chunk_size)
        return {"success": success, "errors": errors}
    except ElasticsearchException as e:
        raise RuntimeError(f"Bulk index failed: {e}") from e


# ----------------------
# Cleanup / close
# ----------------------

async def close_es():
    global _es_client
    if _es_client is not None:
        await _es_client.close()
        _es_client = None
