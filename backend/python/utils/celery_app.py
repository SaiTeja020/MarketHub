# backend/python/utils/celery_app.py
from celery import Celery
import os

DEFAULT_BROKER = "amqp://admin:admin@rabbitmq:5672//"
DEFAULT_BACKEND = "rpc://"

CELERY_BROKER_URL = os.getenv("CELERY_BROKER_URL", DEFAULT_BROKER)
CELERY_BACKEND = os.getenv("CELERY_RESULT_BACKEND", DEFAULT_BACKEND)

# IMPORTANT: change "tasks.gemini" to the actual import path of your gemini.py
# If gemini.py is at /app/tasks/gemini.py -> "tasks.gemini"
# If it's at /app/project/tasks/gemini.py -> "project.tasks.gemini"
celery_app = Celery(
    "market_hub",
    broker=CELERY_BROKER_URL,
    backend=CELERY_BACKEND,
    include=[
        "tasks.gemini",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
)
