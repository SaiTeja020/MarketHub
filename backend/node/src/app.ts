import express from "express";
import productRoutes from "./routes/products.route";
import analyzeRouter from "./routes/analyze";

const app = express();
app.use(express.json({limit: "100kb"}));

app.get("/health", (_req, res) => res.status(200).send("OK"));

app.use("/products", productRoutes);
app.use("/api/analyze", analyzeRouter);

export default app;
