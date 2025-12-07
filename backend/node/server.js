// server.js
// Drop-in Node/Express server that accepts enqueue requests and publishes to RabbitMQ.
// Expects env:
//  - PORT (defaults to 4000)
//  - RABBIT_URL (e.g. amqp://admin:admin@rabbitmq:5672//)
//  - REDIS_URL (e.g. redis://redis:6379/0)  [optional]

const express = require("express");
const amqp = require("amqplib");
const { createClient } = require("redis");
const bodyParser = require("body-parser");

const PORT = parseInt(process.env.PORT || "4000", 10);
const RABBIT_URL = process.env.RABBIT_URL || process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379/0";
const QUEUE_NAME = "scrape_queue";

const app = express();
app.use(bodyParser.json());

// --- Simple logger wrapper ---
function info(...args) {
  console.log(...args);
}
function warn(...args) {
  console.warn(...args);
}
function error(...args) {
  console.error(...args);
}

// --- Redis client (optional usage) ---
let redisClient = null;
async function connectRedis() {
  try {
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on("error", (err) => {
      console.error("Redis client error:", err);
    });
    await redisClient.connect();
    info("✔ Redis connected");
  } catch (err) {
    warn("Redis connection failed:", err?.message ?? err);
    // don't throw — Redis is optional for enqueueing, but we try to connect.
  }
}

// --- RabbitMQ connection with retries ---
let mqConn = null;
let mqChannel = null;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectRabbitWithRetry(retries = 8, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      mqConn = await amqp.connect(RABBIT_URL);
      mqConn.on("error", (err) => {
        error("RabbitMQ connection error:", err);
      });
      mqConn.on("close", () => {
        warn("RabbitMQ connection closed");
      });
      mqChannel = await mqConn.createChannel();
      await mqChannel.assertQueue(QUEUE_NAME, { durable: true });
      info("✔ RabbitMQ connected");
      return mqChannel;
    } catch (err) {
      warn(`RabbitMQ connect attempt ${attempt}/${retries} failed: ${err?.message || err}`);
      if (attempt < retries) {
        await sleep(delayMs);
      } else {
        throw new Error("Could not connect to RabbitMQ after retries: " + (err?.message || err));
      }
    }
  }
}

// --- Enqueue helper ---
function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return String(obj);
  }
}

async function enqueueTask(task) {
  if (!mqChannel) {
    throw new Error("RabbitMQ channel not available");
  }
  const payload = typeof task === "string" ? task : safeStringify(task);
  // send persistent message
  const ok = mqChannel.sendToQueue(QUEUE_NAME, Buffer.from(payload), { persistent: true });
  // log unambiguously
  try {
    const tid = (task && (task.task_id || task.id)) || "unknown";
    info(`ENQUEUE_SENT queue=${QUEUE_NAME} task_id=${tid} payload_len=${Buffer.byteLength(payload)} ts=${new Date().toISOString()}`);
  } catch (e) {
    info("ENQUEUE_SENT queue=" + QUEUE_NAME + " ts=" + new Date().toISOString());
  }
  return ok;
}

// --- Endpoints ---
// Health
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Generic root
app.get("/", (req, res) => {
  res.json({ status: "node_api_running", port: PORT });
});

// Primary enqueue endpoint (POST { task_id, url, ... })
app.post("/enqueue", async (req, res) => {
  const payload = req.body;
  if (!payload || (!payload.task_id && !payload.url && !payload.id)) {
    res.status(400).json({ status: "error", message: "Missing task payload (expecting task_id or url)" });
    return;
  }
  try {
    await enqueueTask(payload);
    // Optionally write a quick Redis marker for visibility
    try {
      if (redisClient) {
        const tid = payload.task_id || payload.id || `auto-${Date.now()}`;
        await redisClient.hSet(`scrape:result:${tid}`, { status: "queued", ts: new Date().toISOString() });
        await redisClient.expire(`scrape:result:${tid}`, 60 * 60 * 24 * 7);
      }
    } catch (rerr) {
      warn("Failed to write Redis marker:", rerr?.message || rerr);
    }
    res.json({ status: "ok", queued: true });
  } catch (err) {
    error("ENQUEUE_ERROR:", err?.stack || err);
    res.status(500).json({ status: "error", message: err?.message || String(err) });
  }
});

// Also provide a /scrape alias because some code expects it
app.post("/scrape", async (req, res) => {
  // reuse same logic
  return app._router.handle(req, res, () => {});
});

// Convenience endpoint to publish a test message (for manual use)
app.post("/publish-test", async (req, res) => {
  const payload = req.body && Object.keys(req.body).length ? req.body : { task_id: `manual-${Date.now()}`, url: "https://example.com" };
  try {
    await enqueueTask(payload);
    res.json({ status: "ok", payload });
  } catch (err) {
    error("publish-test error:", err);
    res.status(500).json({ status: "error", message: err?.message || String(err) });
  }
});

// --- Start up ---
async function start() {
  try {
    await connectRedis();
  } catch (e) {
    warn("Redis init failed (continuing):", e?.message || e);
  }

  try {
    await connectRabbitWithRetry(10, 2000);
  } catch (err) {
    error("FATAL: RabbitMQ connection failed:", err?.message || err);
    // still start server so you can debug; return process exit? We'll keep server up so FastAPI can reach and see errors.
  }

  // Start express server
  app.listen(PORT, "0.0.0.0", () => {
    info(`Server running on port ${PORT}`);
  });
}

// Graceful shutdown
async function shutdown() {
  info("Shutting down node_api...");
  try {
    if (mqChannel) {
      await mqChannel.close();
    }
    if (mqConn) {
      await mqConn.close();
    }
  } catch (e) {
    warn("Error closing RabbitMQ:", e?.message || e);
  }
  try {
    if (redisClient) {
      await redisClient.disconnect();
    }
  } catch (e) {
    warn("Error closing Redis client:", e?.message || e);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// If this file is required by something else, avoid auto-starting twice
if (require.main === module) {
  start().catch((err) => {
    error("Startup error:", err?.stack || err);
    // do not crash the container; keep process alive to allow docker logs and debugging
  });
}

module.exports = app;
