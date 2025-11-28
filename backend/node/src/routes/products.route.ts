import { Router } from "express";
import { handleGetProduct } from "../controllers/products.controller";

const router = Router();

router.get("/:id", handleGetProduct);

export default router;
