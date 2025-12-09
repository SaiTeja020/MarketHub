// src/services/geminiService.ts
import { GoogleGenAI } from "@google/genai";
import { AnalysisResponse } from "../types/serverTypes";

const apiKey = process.env.GENAI_API_KEY;
if (!apiKey) console.warn("GENAI_API_KEY not set; Gemini summary calls will be skipped.");

const ai = new GoogleGenAI({ apiKey });

function mean(nums: number[]) {
  if (!nums.length) return 0;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

/**
 * Detect a spike near the end of the history.
 * Returns { isSpike, spikeIndex, avgBeforeSpike }.
 */
function detectSpike(history: number[]) {
  if (history.length < 4) return { isSpike: false, spikeIndex: null, avgBeforeSpike: mean(history) };

  const n = history.length;
  const tail = history.slice(Math.max(0, n - 6)); // inspect last up to 6 points
  const maxVal = Math.max(...tail);
  const maxIdx = tail.indexOf(maxVal) + (n - tail.length); // index in original history

  // average of values before the peak (use all earlier values)
  const before = history.slice(0, Math.max(0, maxIdx));
  const avgBefore = before.length ? mean(before) : mean(history.slice(0, Math.max(1, n - 3)));

  // require: peak is significantly (>25%) above avgBefore and peak occurs within last 3 items
  const isRecent = (n - 1 - maxIdx) <= 2;
  const isLarge = avgBefore > 0 ? (maxVal / avgBefore) > 1.25 : false;
  const isSpike = isRecent && isLarge;

  return { isSpike, spikeIndex: isSpike ? maxIdx : null, avgBeforeSpike: avgBefore };
}

function computeDeterministicAnalysis(currentPrice: number, history: number[]) {
  const cleanedHistory = (Array.isArray(history) ? history : []).map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!cleanedHistory.length) {
    return {
      score: 50,
      status: "Normal Price" as const,
      reasoning: "No valid historical prices provided.",
      avg: 0,
      min: 0,
      max: 0,
    };
  }

  const avg = mean(cleanedHistory);
  const min = Math.min(...cleanedHistory);
  const max = Math.max(...cleanedHistory);

  const spikeInfo = detectSpike(cleanedHistory);

  let status: "Good Deal" | "Normal Price" | "Bad Deal" | "Fake Deal" = "Normal Price";

  if (spikeInfo.isSpike && currentPrice > spikeInfo.avgBeforeSpike) {
    status = "Fake Deal";
  } else if (currentPrice <= avg * 0.85 || currentPrice <= min * 1.02) {
    status = "Good Deal";
  } else if (currentPrice > avg * 1.10) {
    status = "Bad Deal";
  } else {
    status = "Normal Price";
  }

  let score = 50;
  switch (status) {
    case "Fake Deal": {
      const ratio = spikeInfo.avgBeforeSpike > 0 ? currentPrice / spikeInfo.avgBeforeSpike : 1;
      // For fake deal, the more currentPrice > avgBefore, the lower the score
      score = Math.max(0, Math.round(20 - (ratio - 1) * 40));
      score = Math.min(20, score);
      break;
    }
    case "Bad Deal": {
      const ratio = currentPrice / (avg || 1);
      score = Math.max(21, Math.round(40 - (ratio - 1) * 60));
      score = Math.min(40, score);
      break;
    }
    case "Normal Price": {
      const delta = Math.abs(currentPrice - avg) / (avg || 1);
      score = Math.round(50 - delta * 90);
      if (score < 41) score = 41;
      if (score > 60) score = 60;
      break;
    }
    case "Good Deal": {
      const pctBelow = (avg - currentPrice) / (avg || 1);
      score = Math.round(61 + Math.min(39, pctBelow * 200));
      if (score > 100) score = 100;
      if (score < 61) score = 61;
      break;
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const reasoning = `avg=${avg.toFixed(2)}, min=${min.toFixed(2)}, max=${max.toFixed(2)}, spike=${spikeInfo.isSpike ? "yes" : "no"}`;

  return { score, status, reasoning, avg, min, max };
}

/**
 * Analyze price:
 * - deterministic numeric analysis (always)
 * - optional Gemini call to produce a human-friendly summary & short reasoning
 */
export async function analyzePriceWithGemini(productName: string, currentPrice: number, history: number[]): Promise<AnalysisResponse> {
  const numericHistory = Array.isArray(history) ? history.map((h) => Number(h)).filter((n) => Number.isFinite(n)) : [];
  const validatedCurrent = Number(currentPrice);

  const det = computeDeterministicAnalysis(validatedCurrent, numericHistory);

  const baseResponse: AnalysisResponse = {
    score: det.score,
    status: det.status,
    summary: "",
    reasoning: det.reasoning,
  };

  // If no API key, return deterministic summary
  if (!apiKey) {
    baseResponse.summary = `${productName} current price is ${validatedCurrent}. Classification: ${det.status}. ${det.reasoning}`;
    return baseResponse;
  }

  // Ask Gemini to produce a two-field JSON summary but do NOT let it change numbers
  const prompt = `
You are a concise assistant. Produce EXACTLY a JSON object with:
- "summary": 1-2 sentence human-friendly summary for shoppers.
- "reasoning": 1 short technical sentence.

Use only these facts (do NOT invent numbers):
product_name: "${productName}"
current_price: ${validatedCurrent}
historical_avg: ${det.avg}
historical_min: ${det.min}
historical_max: ${det.max}
classification: "${det.status}"
score: ${det.score}
spike_detected: ${det.reasoning.includes("spike=yes") ? "true" : "false"}

Return ONLY JSON.
`;

  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });

    if (resp.text) {
      try {
        const parsed = JSON.parse(resp.text);
        baseResponse.summary = parsed.summary ?? `${productName} current price ₹${validatedCurrent} — ${det.status}.`;
        baseResponse.reasoning = parsed.reasoning ?? baseResponse.reasoning;
        return baseResponse;
      } catch (err) {
        // fallback to next attempt
      }
    }

    const maybe = (resp as any).output?.[0]?.content?.text?.[0];
    if (maybe) {
      try {
        const parsed = JSON.parse(maybe);
        baseResponse.summary = parsed.summary ?? `${productName} current price ₹${validatedCurrent} — ${det.status}.`;
        baseResponse.reasoning = parsed.reasoning ?? baseResponse.reasoning;
        return baseResponse;
      } catch (err) {
        // continue fallback
      }
    }
  } catch (err) {
    console.error("Gemini summary failed:", err);
  }

  baseResponse.summary = `${productName} current price ₹${validatedCurrent} — classified as "${det.status}".`;
  return baseResponse;
}
