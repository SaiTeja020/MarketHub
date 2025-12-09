// src/routes/analyze.ts
import express from "express";
import { analyzePriceWithGemini } from "../services/geminiService";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { productName, currentPrice, history } = req.body;

    if (typeof productName !== "string" || typeof currentPrice !== "number" || !Array.isArray(history)) {
      return res.status(400).json({ error: "Invalid payload: productName(string), currentPrice(number), history(number[])" });
    }

    if (history.length < 3) {
      return res.status(400).json({ error: "Provide at least 3 historical price points" });
    }

    // Optionally: validate numeric values inside history
    const numericHistory = history.map((h: any) => Number(h)).filter((n: number) => !Number.isNaN(n));
    if (numericHistory.length < history.length) {
      return res.status(400).json({ error: "History must contain only numbers" });
    }

    const result = await analyzePriceWithGemini(productName, currentPrice, numericHistory);
    return res.json(result);
  } catch (err) {
    console.error("Analyze endpoint error:", err);
    return res.status(500).json({ error: "Analysis failed", details: (err as Error).message });
  }
});

export default router;
