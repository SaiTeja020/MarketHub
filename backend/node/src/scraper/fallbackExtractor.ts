// src/scraper/fallbackExtractor.ts
import cheerio from "cheerio";

type FallbackResult = {
  title: string | null;
  current_price: number | null;
  currency: string | null;
  image_url: string | null;
  provenance: {
    method: "cheerio" | "llm" | "none";
    snippet_sent?: string;
    llm_response?: any;
  };
  credibility_score: number; // 0.0 - 1.0
};

const LLM_API_URL = "https://generativelanguage.googleapis.com";
const LLM_API_KEY = "AIzaSyAHdOkX9a08v0DYJx2vyGpf_jS25zE_pdw";

/** fetch page HTML with reasonable headers */
async function fetchHtml(url: string, timeout = 15000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const txt = await res.text();
    return txt;
  } catch (err) {
    console.warn("fetchHtml error:", err);
    return null;
  }
}

/** deterministic parse using cheerio + JSON-LD + meta tags */
function deterministicParse(html: string): Partial<FallbackResult> {
  const $ = cheerio.load(html);

  // title from og/title/tw/meta/head
  let title =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("title").text() ||
    null;
  if (title) title = title.trim();

  // image from meta og:image, twitter image, common selectors
  let image =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $('meta[property="og:image:secure_url"]').attr("content") ||
    $('link[rel="image_src"]').attr("href") ||
    $('img#landingImage').attr("src") ||
    $('img').first().attr("src") ||
    null;

  // price: try JSON-LD first (offers)
  let price: number | null = null;
  const ldScripts = $('script[type="application/ld+json"]')
    .map((i, el) => $(el).html())
    .get();

  for (const block of ldScripts) {
    if (!block) continue;
    try {
      const obj = JSON.parse(block);
      const arr = Array.isArray(obj) ? obj : [obj];
      for (const item of arr) {
        if (item?.offers) {
          const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
          for (const o of offers) {
            const p = o?.price ?? o?.priceSpecification?.price;
            if (p !== undefined && p !== null) {
              const cleaned = String(p).replace(/[^\d.,]/g, "");
              const asNum = Number(cleaned.replace(/,/g, ""));
              if (Number.isFinite(asNum)) {
                price = asNum;
                break;
              }
            }
          }
          if (price != null) break;
        }
      }
      if (price != null) break;
    } catch (e) {
      // ignore JSON parse errors
    }
  }

  // fallback regex search (visible text) for ₹ or Rs or digits
  if (price == null) {
    const bodyText = $("body").text();
    const m =
      bodyText.match(/₹\s*([0-9{1,3},\d]*\.?\d{0,2})/) ||
      bodyText.match(/Rs(?:\.|)\s*([0-9{1,3},\d]*\.?\d{0,2})/) ||
      bodyText.match(/INR\s*([0-9{1,3},\d]*\.?\d{0,2})/);
    if (m && m[1]) {
      const cleaned = m[1].replace(/,/g, "");
      const asNum = Number(cleaned);
      if (Number.isFinite(asNum)) price = asNum;
    }
  }

  const currency = price != null ? "INR" : null;

  return {
    title,
    current_price: price,
    currency,
    image_url: image,
  };
}

/** call LLM provider — expects strict JSON back (caller validates) */
async function callLLMFallback(snippet: string, url: string): Promise<any | null> {
  if (!LLM_API_URL || !LLM_API_KEY) return null;

  // Prompt encourages strict JSON only; adapt model+payload for your provider
  const system = `You are an HTML extractor. Given a URL and an HTML snippet, return exactly ONE JSON object and nothing else.
Keys: title (string|null), price (string|null), currency (string|null), image_url (string|null).
Price should be raw text found on the page (e.g. "₹12,999" or "12,999"). Do NOT add commentary.`;

  const user = `URL: ${url}\n\nHTML_SNIPPET:\n${snippet}\n\nReturn the JSON object only.`;

  try {
    // Generic "chat" shaped request which many providers accept; adapt if your provider differs.
    const payload = {
      model: "gpt-like-or-gemini", // replace if needed
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 600,
      temperature: 0.0,
    };

    const resp = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.warn("LLM call failed:", resp.status, txt);
      return null;
    }
    const data = await resp.json();

    // Try common places for textual content (provider variation)
    const text =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      data?.output?.[0]?.content?.[0]?.text ??
      (typeof data === "string" ? data : null);

    if (!text) return null;

    // Extract JSON substring (first {...})
    const idx = text.indexOf("{");
    const jsonText = idx >= 0 ? text.slice(idx) : text;
    try {
      const parsed = JSON.parse(jsonText);
      return parsed;
    } catch (e) {
      console.warn("LLM returned non-JSON or malformed JSON:", e);
      return null;
    }
  } catch (err) {
    console.warn("callLLMFallback exception:", err);
    return null;
  }
}

/** main entry: deterministic -> llm fallback */
export async function fallbackExtract(url: string): Promise<FallbackResult> {
  const html = await fetchHtml(url);
  if (!html) {
    return {
      title: null,
      current_price: null,
      currency: null,
      image_url: null,
      provenance: { method: "none" },
      credibility_score: 0.0,
    };
  }

  const det = deterministicParse(html);
  const foundPrice = det.current_price != null;
  const foundImage = !!det.image_url;
  const foundTitle = !!det.title;

  if (foundPrice || foundImage || foundTitle) {
    return {
      title: det.title ?? null,
      current_price: det.current_price ?? null,
      currency: det.currency ?? null,
      image_url: det.image_url ?? null,
      provenance: { method: "cheerio" },
      credibility_score: 0.7,
    };
  }

  // If LLM config missing, return none
  if (!LLM_API_URL || !LLM_API_KEY) {
    return {
      title: null,
      current_price: null,
      currency: null,
      image_url: null,
      provenance: { method: "none" },
      credibility_score: 0.0,
    };
  }

  // craft snippet: head + first N chars of body (limit tokens)
  const snippet = (html.slice(0, 20000) + "\n\n" + html.slice(20000, 80000)).slice(0, 100000);
  const llmResp = await callLLMFallback(snippet, url);

  if (!llmResp) {
    return {
      title: null,
      current_price: null,
      currency: null,
      image_url: null,
      provenance: { method: "none" },
      credibility_score: 0.0,
    };
  }

  // Normalize LLM response
  let priceNum: number | null = null;
  const rawPrice = llmResp.price ?? llmResp.current_price ?? null;
  if (rawPrice != null) {
    const s = String(rawPrice).replace(/[^\d.,]/g, "");
    const n = Number(s.replace(/,/g, ""));
    priceNum = Number.isFinite(n) ? n : null;
  }

  return {
    title: llmResp.title ?? null,
    current_price: priceNum,
    currency: llmResp.currency ?? (priceNum ? "INR" : null),
    image_url: llmResp.image_url ?? null,
    provenance: { method: "llm", snippet_sent: snippet.slice(0, 2000), llm_response: llmResp },
    credibility_score: 0.3,
  };
}
