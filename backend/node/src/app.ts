import express from "express";
import cors from "cors";
import productRoutes from "./routes/products.route";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

app.use("/products", productRoutes);

export default app;
