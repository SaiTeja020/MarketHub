from fastapi import FastAPI, HTTPException
import psycopg2
import psycopg2.extras
import redis

import os, time, json, traceback
from typing import Optional

# Try to import celery task interface if present. If not, the code will still work
# and fall back to enqueuing via celery.send_task when available.

try:
    from celery_app import celery as celery_app #celery_app.celery
    CELERY_AVAILABLE = True
except Exception:
    celery_app = None
    CELERY_AVAILABLE = False
# ----------------------------------------
# 1. Config
# ----------------------------------------

DATABASE_URL = os.getenv("DATABASE_URL")        # use pooler string with sslmode=require
REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = int(od.getenv("REDIS_PORT", 6379))
RABBIT_URL = os.getenv("RABBIT_URL", "amqp://admin:admin@rabbitmq:5672//")

# Age thresholds (seconds)
FRESH_SECONDS = 60 * 60         # 1 hour
STALE_SECONDS = 6 * 60 * 60     # 6 hours

# Lock TTL for scraping (seconds)
SCRAPE_LOCK_TTL = 60 * 5  # 5 minutes

# How long to cache items in Redis (safety TTL)
CACHE_TTL_SECONDS = 24 * 3600  # 24 hours

# -----------------------------
# DB Connection (sync)
# -----------------------------
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is required")

# Connect with SSL (required by Supabase)

conn = psycopg2.connect(DATABASE_URL, sslmode="require")


# ----------------------------------------
# 2. Redis Connection
# ----------------------------------------
redis_client = redis.Redis(host="REDIS_HOST",port="REDIS_POST",decode_responses=True)  # returns strings, not bytes


# ----------------------------------------
# 3. Create FastAPI App
# ----------------------------------------

app = FastAPI(title="MarketHub Backend")

# -----------------------------
# Helpers
# -----------------------------

def now_ts():
    return int(time.time())

def meta_key(product_id: str) -> str:
    return f"product_meta:{product_id}"

def product_key(product_id: str) -> str:
    return f"product:{product_id}"

def history_key(product_id: str) -> str:
    return f"price_history:{product_id}"

def retailers_key(product_id: str) -> str:
    return f"retailers:{product_id}"

def lock_key(product_id: str) -> str:
    return f"scrape_lock:{product_id}"

def get_meta(product_id: str) -> str:
    raw = redis_client.get(meta_key(product_key))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None
    
def set_meta(product_id: str, meta: dict):
    redis_client.set(meta_key(product_id), json.dumps(meta), ex=CACHE_TTL_SECONDS)

def acquire_lock(product_id: str, ttl: int = SCRAPE_LOCK_TTL) -> bool:
    k = lock_key(product_id)
    # set nx ensures atomic acquire
    return redis_client.set(k, "1", nx = True, ex =ttl) is True

def release_lock(product_id: str):
    redis_client.delete(lock_key(product_id))

# -----------------------------
# DB read helpers
# -----------------------------

def db_get_product(product_id: str) -> Optional[dict]:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT id, title, url, image_url, current_price,
               lowest_price, highest_price, created_at
        FROM products
        WHERE id = %s
    """, (product_id,))
    row = cur.fetchone()
    cur.close()
    return dict(row) if row else None

def db_get_price_history(product_id: str):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT id, price, tracked_at
        FROM price_history
        WHERE product_id = %s
        ORDER BY tracked_at ASC
    """, (product_id,))
    rows = cur.fetchall()
    cur.close()
    return [dict(r) for r in rows]

def db_get_retailers(product_id: str):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT retailer_name, price, recorded_at
        FROM retailer_prices
        WHERE product_id = %s
        ORDER BY recorded_at DESC
    """, (product_id,))
    rows = cur.fetchall()
    cur.close()
    return [dict(r) for r in rows]

# -----------------------------
# DB write helpers (used by scraper)
# Implement these to match your schema and constraints.
# -----------------------------

def db_upsert_products(product_obj: dict):
    """
    Upsert minimal fields into products table (example).
    product_obj must contain id and the fields to update like current_price, lowest_price, etc.
    """

    cur = conn.cursor()
    # example: update current_price and maybe lowest/highest
    cur.execute("""
        UPDATE products
        SET current_price = %s, lowest_price = %s, highest_price = %s
        WHERE id = %s
    """, (
        product_obj.get("current_price"),
        product_obj.get("lowest_price"),
        product_obj.get("highest_price"),
        product_obj.get("id"),
    ))
    conn.commit()
    cur.close()

def db_insert_price_history(product_id: str, price:float, tracked_at_ts: int):
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO price_history (product_id, price, tracked_at)
        VALUES (%s, %s, to_timestamp(%s))
    """, (product_id, price, tracked_at_ts))
    conn.commit()
    cur.close()

# -----------------------------
# Scraper integration (placeholder)
# Replace fetch_from_scraper() with your real scraper.
# Should return dict with product fields, list of price history points, retailers list.
# -----------------------------

def fetch_from_scraper(product_id: str) ->dict:
    """
    Placeholder scraping function.
    Replace the content with your real scraping logic (requests/bs4/playwright etc.)
    Must return:
    {
      "product": { id, title, url, image_url, current_price, lowest_price, highest_price, created_at? },
      "price_history": [ { "price": 1999, "tracked_at": 1700000000 }, ... ],
      "retailers": [ { "retailer_name": "Amazon", "price": 1999, "recorded_at": 1700000000 }, ... ]
    }
    """
    # ---- MOCK / STUB ----
    ts = now_ts()
    mock_product = {
        "id": product_id,
        "title": f"Mock product {product_id}",
        "url": f"https://example.com/p/{product_id}",
        "image_url": None,
        "current_price": 999,
        "lowest_price": 899,
        "highest_price": 1299,
        "created_at": ts
    }
    mock_history = [
        {"price": 1299, "tracked_at": ts - 86400*2},
        {"price": 1099, "tracked_at": ts - 86400},
        {"price": 999, "tracked_at": ts},
    ]
    mock_retailers = [
        {"retailer_name": "RetailerA", "price": 999, "recorded_at": ts},
        {"retailer_name": "RetailerB", "price": 1049, "recorded_at": ts}
    ]
    return {"product": mock_product, "price_history": mock_history, "retailers": mock_retailers}

# -----------------------------
# Scrape & update routine (atomic-ish)
# This function is used by both Celery worker (background) and immediate sync scrape.
# -----------------------------

def perform_scrape_and_update(product_id: str, triggered_by: str = "sync") -> dict:
    """
    Perform scraping, update DB, update Redis caches and meta.
    Returns the fresh product object.
    """
    # Acquire a lock to avoid concurrent scrapes
    got_lock = acquire_lock(product_id)
    if not got_lock:
        # Another worker is scraping; return current cached data (if any)
        existing = redis_client.get(product_key[product_id])
        if existing:
            return json.loads(existing)
        # else fallback to DB
    try:
        # Fetch data from scraper (replace with actual scraper)
        scraped = fetch_from_scraper(product_id)
        product_obj = scraped.get("product")
        history = scraped.get("price_history", []);
        retailers = scraped.get("retailers", [])
         # 1) Update DB (persist authoritative data)
        try:
            if product_obj:
                db_upsert_product(product_id)
            # Save price history rows
            for ph in history:
                # insert into price_history; ensure tracked_at provided
                tracked_at_ts = ph.get("tracked_at", now_ts())
                db_insert_price_history(product_id, ph.get("price"), tracked_at_ts)
        except Exception:
            # DB update failure is bad but we should continue to update cache
            print("Warning: DB update failed:", traceback.format_exc())
        # 2) Update Redis caches (overwrite AFTER success)
        if product_obj:
            redis_client.set(product_key(product_id), json.dumps(product_obj), ex=CACHE_TTL_SECONDS)
        if history:
            redis_client.set(history_key(product_id), json.dumps(history), ex=CACHE_TTL_SECONDS)
        if retailers:
            redis_client.set(retailers_key(product_id), json.dumps(retailers), ex=CACHE_TTL_SECONDS)
        # 3) Update metadata
        meta = {"scraped_at": now_ts(), "triggered_by": triggered_by}
        set_meta(product_id, meta)

        return product_obj or {}
    finally:
        # always release lock if we acquired it
        try:
            release_lock(product_id)
        except Exception:
            pass

# -----------------------------
# Enqueue background scrape via Celery/RabbitMQ (if available)
# -----------------------------
def enqueue_background_scrape(product_id: str):
    """
    Enqueue a background scrape. If Celery is available, use send_task to avoid importing tasks module.
    If not available, do nothing (or you can fallback to synchronous scrape).
    """
    if not CELERY_AVAILABLE or celery_app is None:
        # fallback: flame out gracefully (we could spawn a thread, but keep behaviour predictable)
        print("Celery not available; cannot enqueue background scrape for", product_id)
        return False
    try:
        # Use send_task so worker name is decoupled (worker should have a task registered like "tasks.scrape_product")
        # Replace 'tasks.scrape_product' with your actual task name in the worker.
        celery_app.send_task("tasks.scrape_product", args=[product_id], queue="default")
        return True
    except Exception:
        print("Failed to enqueue Celery task:", traceback.format_exc())
        return False
    
# -----------------------------
# Decision helper based on metadata age
# -----------------------------

def decide_action(product_id: str) -> str:
    """
    Returns:
      - "return_cached"  (age < 1h)
      - "return_and_enqueue" (1-6h)
      - "immediate_scrape" (>=6h or no meta)
    """
    meta = get_meta(product_id)
    if not meta or "scraped_at" not in meta:
        # No metadata: treat as immediate scrape (we want fresh data on first access)
        return "immediate_scrape"
    try:
        scraped_at = int(meta.get("scraped_at", 0))
    except Exception:
        scraped_at = 0
    age = now_ts() - scraped_at
    if age < FRESH_SECONDS:
        return "return_cached"
    if age < STALE_SECONDS:
        return "return_and_enqueue"
    return "immediate_scrape"
# ----------------------------------------
# 4. Health check
# ----------------------------------------

@app.get("/health")
def health():
    return { "status": "ok"}

# ----------------------------------------
# Routes
# ----------------------------------------

# PRODUCT route with caching/scrape logic
@app.get("/products/{product_id}")
def get_product_route(product_id: str):
    try:
        action = decide_action(product_id)

        # If cached data present, return it (fast path)
        cached = redis_client.get(product_key(product_id))
        if cached:
            cached_obj = json.loads(cached)
        else:
            cached_obj = None

        if action == "return_cached":
            if cached_obj:
                return {"source": "cache", "product": cached_obj}
            # no cache despite "fresh" meta → fallback to DB fetch and update meta
            db_obj = db_get_product(product_id)
            if db_obj:
                # update Redis meta and cache
                redis_client.set(product_key(product_id), json.dumps(db_obj), ex=CACHE_TTL_SECONDS)
                set_meta(product_id, {"scraped_at": now_ts(), "triggered_by": "db-fallback"})
                return {"source": "db", "product": db_obj}
            raise HTTPException(404, "Product not found")

        elif action == "return_and_enqueue":
            # return cached if available, and enqueue background scrape
            if cached_obj:
                # attempt to enqueue (best-effort)
                enqueued = enqueue_background_scrape(product_id)
                return {"source": "cache", "enqueued": enqueued, "product": cached_obj}
            else:
                # if no cached data, fallback to immediate scrape (synchronous)
                fresh = perform_scrape_and_update(product_id, triggered_by="sync-fallback")
                if not fresh:
                    raise HTTPException(404, "Product not found after scraping")
                return {"source": "scrape", "product": fresh}

        else:  # immediate_scrape
            # If cache exists but old, we still return cached immediately and then decide:
            # Per your requirement: for >6h we should IMMEDIATELY scrape and return fresh result.
            # We'll attempt to run the scrape synchronously (with lock) and return fresh data.
            # Acquire lock to avoid multiple concurrent immediate scrapes.
            if acquire_lock(product_id):
                try:
                    fresh = perform_scrape_and_update(product_id, triggered_by="immediate")
                    if fresh:
                        return {"source": "scrape", "product": fresh}
                    # If scrape returned empty, fallback to cache or DB
                    if cached_obj:
                        return {"source": "cache-stale", "product": cached_obj}
                    db_obj = db_get_product(product_id)
                    if db_obj:
                        redis_client.set(product_key(product_id), json.dumps(db_obj), ex=CACHE_TTL_SECONDS)
                        return {"source": "db", "product": db_obj}
                    raise HTTPException(404, "Product not found after scraping")
                finally:
                    release_lock(product_id)
            else:
                # Another process is scraping. Return cached (if any) or DB fallback.
                if cached_obj:
                    return {"source": "cache-waiting", "product": cached_obj}
                db_obj = db_get_product(product_id)
                if db_obj:
                    redis_client.set(product_key(product_id), json.dumps(db_obj), ex=CACHE_TTL_SECONDS)
                    return {"source": "db", "product": db_obj}
                raise HTTPException(503, "Another process is scraping; try again shortly")

    except HTTPException:
        raise
    except Exception as e:
        print("Error in /products:", traceback.format_exc())
        raise HTTPException(500, f"Internal error: {e}")


# PRICE HISTORY route same pattern
@app.get("/price-history/{product_id}")
def price_history_route(product_id: str):
    try:
        action = decide_action(product_id)
        cached = redis_client.get(history_key(product_id))
        cached_rows = json.loads(cached) if cached else None

        if action == "return_cached":
            if cached_rows:
                return {"source": "cache", "price_history": cached_rows}
            rows = db_get_price_history(product_id)
            redis_client.set(history_key(product_id), json.dumps(rows), ex=CACHE_TTL_SECONDS)
            return {"source": "db", "price_history": rows}

        elif action == "return_and_enqueue":
            if cached_rows:
                enqueue_background_scrape(product_id)
                return {"source": "cache", "enqueued": True, "price_history": cached_rows}
            else:
                # no cached, synchronous scrape fallback
                fresh = perform_scrape_and_update(product_id, triggered_by="sync-fallback")
                rows = db_get_price_history(product_id)
                redis_client.set(history_key(product_id), json.dumps(rows), ex=CACHE_TTL_SECONDS)
                return {"source": "scrape", "price_history": rows}

        else:  # immediate_scrape
            # immediate scraping for history as well
            if acquire_lock(product_id):
                try:
                    perform_scrape_and_update(product_id, triggered_by="immediate")
                    rows = db_get_price_history(product_id)
                    redis_client.set(history_key(product_id), json.dumps(rows), ex=CACHE_TTL_SECONDS)
                    return {"source": "scrape", "price_history": rows}
                finally:
                    release_lock(product_id)
            else:
                if cached_rows:
                    return {"source": "cache-waiting", "price_history": cached_rows}
                rows = db_get_price_history(product_id)
                redis_client.set(history_key(product_id), json.dumps(rows), ex=CACHE_TTL_SECONDS)
                return {"source": "db", "price_history": rows}

    except Exception as e:
        print("Error in /price-history:", traceback.format_exc())
        raise HTTPException(500, f"Internal error: {e}")

    
# RETAILERS route same pattern
@app.get("/retailers/{product_id}")
def retailers_route(product_id: str):
    try:
        action = decide_action(product_id)
        cached = redis_client.get(retailers_key(product_id))
        cached_rows = json.loads(cached) if cached else None

        if action == "return_cached":
            if cached_rows:
                return {"source": "cache", "retailers": cached_rows}
            rows = db_get_retailers(product_id)
            redis_client.set(retailers_key(product_id), json.dumps(rows), ex=CACHE_TTL_SECONDS)
            return {"source": "db", "retailers": rows}

        elif action == "return_and_enqueue":
            if cached_rows:
                enqueue_background_scrape(product_id)
                return {"source": "cache", "enqueued": True, "retailers": cached_rows}
            else:
                fresh = perform_scrape_and_update(product_id, triggered_by="sync-fallback")
                rows = db_get_retailers(product_id)
                redis_client.set(retailers_key(product_id), json.dumps(rows), ex=CACHE_TTL_SECONDS)
                return {"source": "scrape", "retailers": rows}

        else:  # immediate_scrape
            if acquire_lock(product_id):
                try:
                    perform_scrape_and_update(product_id, triggered_by="immediate")
                    rows = db_get_retailers(product_id)
                    redis_client.set(retailers_key(product_id), json.dumps(rows), ex=CACHE_TTL_SECONDS)
                    return {"source": "scrape", "retailers": rows}
                finally:
                    release_lock(product_id)
            else:
                if cached_rows:
                    return {"source": "cache-waiting", "retailers": cached_rows}
                rows = db_get_retailers(product_id)
                redis_client.set(retailers_key(product_id), json.dumps(rows), ex=CACHE_TTL_SECONDS)
                return {"source": "db", "retailers": rows}

    except Exception as e:
        print("Error in /retailers:", traceback.format_exc())
        raise HTTPException(500, f"Internal error: {e}")

# ANALYZE placeholder: enqueues a scoring job (background)
@app.post("/analyze/{product_id}")
def analyze_product_route(product_id: str):
    try:
        # Prefer enqueuing a Celery LLM scoring task
        ok = enqueue_background_scrape(product_id)  # reuse enqueue for scraping/analysis
        if ok:
            return {"status": "queued", "message": "Background job enqueued"}
        # fallback: trigger synchronous scrape (less ideal)
        fresh = perform_scrape_and_update(product_id, triggered_by="analyze-sync")
        if fresh:
            return {"status": "done", "product": fresh}
        raise HTTPException(500, "Failed to analyze product")
    except Exception as e:
        print("Error in /analyze:", traceback.format_exc())
        raise HTTPException(500, f"Internal error: {e}")
Quick notes and things to customize