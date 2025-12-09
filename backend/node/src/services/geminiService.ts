// src/services/geminiService.ts
import { GoogleGenAI, Type } from "@google/genai";
import { AnalysisResponse } from "../types/serverTypes";

const apiKey = process.env.GENAI_API_KEY;
if (!apiKey) {
  console.warn('GENAI_API_KEY not set; Gemini calls will fail.');
}

const ai = new GoogleGenAI({ apiKey });

export async function analyzePriceWithGemini(
  productName: string,
  currentPrice: number,
  history: number[]
): Promise<AnalysisResponse> {
  const model = "gemini-2.5-flash";
  const historyStr = history.join(", ");

  const prompt = `
Analyze the following price data for a product specifically to determine if the current price is a good deal, a normal price, or a "fake deal".

Product: ${productName}
Current Price: ${currentPrice}
Historical Prices (Chronological order, oldest to newest): [${historyStr}]

Rules for classification:
1. Fake Deal: If the price history shows a distinct rise in price shortly before the current price (a sudden spike), followed by a drop that matches the current price, AND the current price is still above the historical average (excluding the spike), mark this as a "Fake Deal".
2. Normal Price: If the price is stable, oscillating slightly around the average, or if the current price is neither significantly low nor high compared to the trend, mark as "Normal Price".
3. Good Deal: If the current price is significantly below the historical average or near historical lows.
4. Bad Deal: If the current price is significantly above historical average without the "fake deal" pattern.

Score calculation (0-100):
- 0-20: Terrible / Fake Deal
- 21-40: Bad Deal
- 41-60: Normal
- 61-80: Good Deal
- 81-100: Historic low / Amazing

Provide a JSON object with fields: score (0-100), summary (3-4 line string), status (one of "Good Deal","Normal Price","Bad Deal","Fake Deal"), reasoning (brief technical reason).
`;

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          score: { type: Type.INTEGER },
          summary: { type: Type.STRING },
          status: { type: Type.STRING },
          reasoning: { type: Type.STRING },
        },
        required: ["score", "summary", "status", "reasoning"],
      },
    },
  });

  // SDK often gives result in response.text when responseMimeType is application/json
  if (response.text) {
    try {
      const parsed = JSON.parse(response.text);
      return parsed as AnalysisResponse;
    } catch (err) {
      // fallback: try to find content text in response.output
      // (structure may vary across SDK versions)
    }
  }

  // Attempt fallback parsing if SDK includes output array
  try {
    // @ts-ignore
    const maybeText = response.output?.[0]?.content?.text?.[0];
    if (maybeText) {
      return JSON.parse(maybeText) as AnalysisResponse;
    }
  } catch (err) {
    // ignore and throw below
  }

  throw new Error("No usable response from Gemini.");
}
