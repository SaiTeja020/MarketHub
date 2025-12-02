// src/lib/api.js
import axios from "axios";

const BASE_URL = import.meta.env.VITE_API_URL || "http://fastapi:8000";

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
});

// Optional: attach token if using Supabase auth
api.interceptors.request.use(async (config) => {
  const token = localStorage.getItem("access_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default api;

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
