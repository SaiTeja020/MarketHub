// utils/rabbitmq.ts

import amqp from "amqplib";

let mqChannel: amqp.Channel | null = null;

export const connectQueue = async () => {
  if (mqChannel) return mqChannel; // already connected

  const conn = await amqp.connect(process.env.RABBIT_URL!);
  mqChannel = await conn.createChannel();

  console.log("✔ RabbitMQ connected");

  return mqChannel;
};

export { mqChannel as channel }; // <-- export the variable!
