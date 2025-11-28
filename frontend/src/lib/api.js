// src/lib/api.js

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export async function startScrape(url, source) {
  const res = await fetch(`${BASE_URL}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, source })
  });
  return res.json();
}

export async function getScrapeResult(taskId) {
  const res = await fetch(`${BASE_URL}/scrape/result/${taskId}`);
  return res;
}

export async function startAnalysis(product) {
  const res = await fetch(`${BASE_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(product)
  });
  return res.json();
}

export async function getAnalysisResult(taskId) {
  const res = await fetch(`${BASE_URL}/analyze/result/${taskId}`);
  return res;
}

export async function getDealSummary(productId) {
  const res = await fetch(`${BASE_URL}/deal/${productId}`);
  return res.json();
}
