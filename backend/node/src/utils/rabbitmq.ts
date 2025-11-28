import amqp from "amqplib";

let channel: any ;

export const connectQueue = async () => {
  const conn = await amqp.connect(process.env.RABBIT_URL!);
  channel = await conn.createChannel();
  await channel.assertQueue("scrape_queue");
};

export const pushScrapeTask = async (productId: string) => {
  channel.sendToQueue("scrape_queue", Buffer.from(JSON.stringify({ productId })));
};
