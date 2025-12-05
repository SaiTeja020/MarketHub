import app from "./app";
import { connectQueue } from "./utils/rabbitmq";


const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));

const start = async () => {
    await connectQueue();
    app.listen(PORT, () => console.log("Server running on port", PORT));
};

start();
