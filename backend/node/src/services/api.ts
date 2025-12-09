// src/services/api.ts
export async function analyzePriceServer(productName: string, currentPrice: number, history: number[]) {
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productName, currentPrice, history }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || "Failed to analyze");
    }
    return (await resp.json()) as {
      score: number;
      summary: string;
      status: string;
      reasoning: string;
    };
  }
  