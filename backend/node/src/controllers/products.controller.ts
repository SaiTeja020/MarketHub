import { Request, Response } from "express";
import { getProductData } from "../services/product.service";

export const handleGetProduct = async (req: Request, res: Response) => {
  try {
    const productId = req.params.id;
    const data = await getProductData(productId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
};
