// @ts-nocheck
/**
 * Supabase Edge Function: analyze-deal
 *
 * Deploy this to: supabase functions deploy analyze-deal
 *
 * Expects a POST with JSON body:
 * {
 *   product: {
 *     id?,
 *     title?,
 *     url?,
 *     image_url?,
 *     current_price?,
 *     lowest_price?,
 *     highest_price?,
 *     created_at?
 *   },
 *   priceHistory?: [{ tracked_at, price }, ...]  // optional
 *   retailerPrices?: [{ retailer_name, price, recorded_at }, ...] // optional
 * }
 *
 * Returns:
 * {
 *   score: number,            // 0-100
 *   verdict: "buy_now"|"wait"|"neutral",
 *   reasons: string[],
 *   recommendation: string,
 *   raw: any                  // raw OpenAI response (for debugging)
 * }
 *
 * ENV variables required:
 * - OPENAI_API_KEY  (required)
 * - OPENAI_MODEL    (optional, defaults to "gpt-4o-mini" or "gpt-4o")
 *
 * NOTE: This function expects the frontend to pass a valid Supabase access token
 * in the Authorization header: "Bearer <JWT>" (optional, but recommended).
 *
 * Uploaded design file (for reference / UI): "/mnt/data/75a6027f-3644-4613-9a3d-dd4cca600172.png"
 * (Your deployment tooling will convert that path into a public URL if you want to show it.)
 */

import { serve } from "std/server";

type Product = {
  id?: string;
  title?: string;
  url?: string;
  image_url?: string;
  current_price?: number | null;
  lowest_price?: number | null;
  highest_price?: number | null;
  created_at?: string | null;
};

type PricePoint = { tracked_at: string; price: number | string };
type Retailer = { retailer_name: string; price: number | string; recorded_at?: string };

const DESIGN_IMAGE_PATH = "/mnt/data/75a6027f-3644-4613-9a3d-dd4cca600172.png";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini"; // change to your preferred model

if (!OPENAI_API_KEY) {
  // We still export the serve handler below — but runtime will error if key missing
  console.warn("Warning: OPENAI_API_KEY is not set. The function will fail without it.");
}

function safeNumber(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildPrompt(product: Product, priceHistory: PricePoint[], retailerPrices: Retailer[]) {
  const title = product.title || "Unknown product";
  const cur = safeNumber(product.current_price);
  const low = safeNumber(product.lowest_price);
  const high = safeNumber(product.highest_price);

  // Make a compact textual series of recent points
  const lastPoints = (priceHistory || [])
    .slice(-12)
    .map((p) => {
      const date = p.tracked_at ? new Date(p.tracked_at).toLocaleDateString() : "";
      const price = safeNumber(p.price);
      return `${date}: ${price === null ? "?" : `₹${price}`}`;
    })
    .join("\n");

  const retailers = (retailerPrices || [])
    .slice(0, 10)
    .map((r) => `${r.retailer_name}: ₹${safeNumber(r.price) ?? "?"} ${r.recorded_at ? `(${new Date(r.recorded_at).toLocaleDateString()})` : ""}`)
    .join("\n");

  // Instruction: ask the model to return a small JSON object with fields
  return `
You are a crisp, factual deal-analysis assistant. Analyze a product's price and price history and return a concise evaluation.

Product:
- title: ${title}
- current_price: ${cur === null ? "unknown" : `₹${cur}`}
- lowest_price: ${low === null ? "unknown" : `₹${low}`}
- highest_price: ${high === null ? "unknown" : `₹${high}`}
- product_url: ${product.url || "unknown"}
- image_reference: ${DESIGN_IMAGE_PATH}  // local design / optional

Price history (most recent up to 12 points, oldest first):
${lastPoints || "no history"}

Retailer prices (most recent snapshot):
${retailers || "none"}

Task:
1) Return a JSON object only (no extra prose) with keys:
   - score: integer between 0 and 100 (100 = excellent buy now),
   - verdict: one of "buy_now", "wait", or "neutral",
   - reasons: an array of 1-4 short strings explaining the decision,
   - recommendation: a 1-2 sentence user facing suggestion.

2) Base the score on:
   - how far below highest_price or average it is,
   - recent trend (falling -> higher score),
   - retailer competition (if others cheaper -> act accordingly),
   - completeness of data (if missing, be conservative).

3) Keep reasoning grounded in the numerical facts provided. Do NOT hallucinate data.

Return strictly valid JSON (no surrounding backticks or markdown).
`;
}

async function callOpenAI(prompt: string) {
  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "You are a fact-based price analysis assistant. Keep answers concise and numeric where possible." },
      { role: "user", content: prompt },
    ],
    temperature: 0.15,
    max_tokens: 400,
    n: 1,
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI API error: ${resp.status} ${txt}`);
  }
  const json = await resp.json();
  return json;
}

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Only POST allowed" }), { status: 405 });
    }

    // Optional: quick auth check - expects frontend to send Authorization: Bearer <supabase jwt>
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing Authorization header (Bearer <token>)" }), { status: 401 });
    }

    // Parse body
    const body = await req.json().catch(() => null);
    if (!body) {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
    }

    const product: Product = body.product || null;
    const priceHistory: PricePoint[] = Array.isArray(body.priceHistory) ? body.priceHistory : [];
    const retailerPrices: Retailer[] = Array.isArray(body.retailerPrices) ? body.retailerPrices : [];

    if (!product) {
      return new Response(JSON.stringify({ error: "Missing product object in request body" }), { status: 400 });
    }

    if (!OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "Server misconfigured: OPENAI_API_KEY not set" }), { status: 500 });
    }

    const prompt = buildPrompt(product, priceHistory, retailerPrices);

    // Call OpenAI
    const openAiRaw = await callOpenAI(prompt);

    // Extract text reply: support both top-level response and streaming
    const content = openAiRaw?.choices?.[0]?.message?.content;
    let parsed: any = null;
    if (content) {
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        // If JSON parsing fails, still return the raw content for debugging
        parsed = { parsingError: e.message, text: content };
      }
    }

    // If parsed does not contain score/verdict, try to craft a fallback
    const fallback = {
      score: parsed?.score ?? 50,
      verdict: parsed?.verdict ?? "neutral",
      reasons: parsed?.reasons ?? (parsed?.text ? [String(parsed?.text).slice(0, 200)] : ["Insufficient data"]),
      recommendation: parsed?.recommendation ?? "Not enough data to make a clear recommendation.",
    };

    const result = {
      ...(typeof parsed === "object" ? parsed : {}),
      score: Number(fallback.score),
      verdict: fallback.verdict,
      reasons: fallback.reasons,
      recommendation: fallback.recommendation,
      raw: openAiRaw,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("analyze-deal error", err);
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
