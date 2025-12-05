import express from "express";
import productRoutes from "./routes/products.route";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.status(200).send("OK"));

app.use("/products", productRoutes);

export default app;
