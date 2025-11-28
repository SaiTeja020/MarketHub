import Redis from "ioredis";

export const redisClient = new Redis({
  url: process.env.REDIS_URL,
});

redisClient.on("error", (err: Error) => console.error("Redis Error:", err));

export const redis = async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
};
