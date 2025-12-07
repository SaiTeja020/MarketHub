# backend/python/api/utils/rabbit_publish.py
import os
import json
import asyncio
import aio_pika

RABBIT_URL = os.getenv("RABBIT_URL")

async def publish_scrape_job(payload: dict):
    """
    Connects to RabbitMQ and publishes payload to the default exchange
    with routing_key 'scrape_queue'. This is a short-lived connection
    (connect -> publish -> close) which is fine for low-mid traffic.
    """
    if not RABBIT_URL:
        raise RuntimeError("RABBIT_URL not configured")

    # connect_robust will auto-retry on intermittent network errors
    conn = await aio_pika.connect_robust(RABBIT_URL)
    try:
        channel = await conn.channel()
        # ensure the queue exists (idempotent)
        await channel.declare_queue("scrape_queue", durable=True)
        message = aio_pika.Message(
            body=json.dumps(payload).encode("utf-8"),
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
        )
        await channel.default_exchange.publish(message, routing_key="scrape_queue")
    finally:
        await conn.close()
