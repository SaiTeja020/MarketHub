// src/utils/rabbitmq.ts
import amqp from "amqplib";

let channel: amqp.Channel | null = null;

export const connectRabbit = async () => {
  const conn = await amqp.connect(process.env.RABBITMQ_URL || "amqp://rabbitmq");
  channel = await conn.createChannel();
};

export const pushScrapeTask = async (queueName: string, task: any) => {
  if (!channel) await connectRabbit();
  channel!.assertQueue(queueName, { durable: true });
  channel!.sendToQueue(queueName, Buffer.from(JSON.stringify(task)), { persistent: true });
};

export const getChannel = () => channel;
