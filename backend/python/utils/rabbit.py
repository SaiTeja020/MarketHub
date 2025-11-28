# utils/rabbit.py
import os
import json
import asyncio
from aio_pika import connect_robust, Message

RABBIT_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@localhost/")

# Keep a single connection per process
_connection = None
_channel = None
_lock = asyncio.Lock()

async def _ensure():
    global _connection, _channel
    async with _lock:
        if _connection is None or _channel is None:
            _connection = await connect_robust(RABBIT_URL)
            _channel = await _connection.channel()
    return _channel

async def publish_message(queue_name: str, body: str):
    """
    Publish a message to a named queue. The consumer is expected to
    declare the queue and handle messages.
    """
    channel = await _ensure()
    exchange = channel.default_exchange
    # For simple queue push, publish with routing_key = queue_name
    await exchange.publish(
        Message(body.encode()),
        routing_key=queue_name
    )
