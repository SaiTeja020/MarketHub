// src/routes/analyze.ts
import express from "express";
import { analyzePriceWithGemini } from "../services/geminiService";

const router = express.Router();

/**
 * POST /analyze
 * Body: { product_id?: string, title?: string, image_url?: string, current_price: number, history: number[] }
 */
router.post("/", async (req, res) => {
  try {
    console.log("[/analyze] request body:", JSON.stringify(req.body));

    const { product_id, title, image_url, current_price, history } = req.body ?? {};

    // Basic validation
    if (current_price == null || Number.isNaN(Number(current_price))) {
      return res.status(400).json({ error: "current_price (number) is required" });
    }

    if (!Array.isArray(history) || history.length < 1) {
      // You can enforce a minimum history length. If you prefer to allow analysis without history,
      // change this to a warning (200) instead of 400.
      return res.status(400).json({ error: "history (number[]) is required and should have at least 1 entry" });
    }

    // Validate that history is numeric
    const numericHistory = history.map((h: any) => Number(h)).filter((n: number) => Number.isFinite(n));
    if (numericHistory.length === 0) {
      return res.status(400).json({ error: "history must contain numeric values" });
    }

    // Call the analysis service (synchronous)
    const productName = title ?? product_id ?? "Product";
    const currentPriceNum = Number(current_price);

    const analysis = await analyzePriceWithGemini(productName, currentPriceNum, numericHistory);

    // Return full structured response
    return res.json({ analysis });
  } catch (err: any) {
    console.error("[/analyze] error:", err);
    return res.status(500).json({ error: "Analysis failed", details: err?.message ?? String(err) });
  }
});

export default router;
