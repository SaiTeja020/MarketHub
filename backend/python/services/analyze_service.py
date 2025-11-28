# services/analyze_service.py
"""
This file exposes a Celery task stub that we import into FastAPI.
We intentionally import the Celery task module via utils.celery_app so the
task function is known to Celery workers.
"""
from utils.celery_app import celery_app

# This is a Celery shared task defined in tasks/analyze_tasks.py named 'analyze.product'
# For convenience, we create a wrapper to call the Celery task.
# We return the Celery AsyncResult object for inspection if needed.

request_analysis = celery_app.task(name="gateway.request_analysis")(
    lambda payload: __import__("tasks.analyze_tasks").analyze_product.delay(payload)
)
# Note:
# - request_analysis.delay(payload) will call analyze_product.delay(payload) under the hood.
# - In many setups you might call analyze_product.delay(payload) directly by importing the task.
#   This wrapper keeps FastAPI decoupled from the implementation import path.

async def get_analysis_result(task_id: str):
    """
    Lookup analysis result in Redis (set by the Celery analysis task).
    """
    from utils.redis_client import get_redis
    redis = await get_redis()
    key = f"analyze:result:{task_id}"
    r = await redis.get(key)
    if r is None:
        return None
    import json
    return json.loads(r)
