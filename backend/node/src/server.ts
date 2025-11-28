import app from "./app";
import { connectQueue } from "./utils/rabbitmq";

const PORT = process.env.PORT || 4000;

const start = async () => {
    await connectQueue();
    app.listen(PORT, () => console.log("Server running on port", PORT));
};

start();
