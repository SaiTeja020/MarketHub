import express from "express";
import productRoutes from "./routes/products.route";

const app = express();
app.use(express.json());

app.use("/products", productRoutes);

export default app;
