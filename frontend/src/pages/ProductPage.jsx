// src/pages/ProductPage.jsx
import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../lib/api.js";
import {
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Area,
  AreaChart,
  ResponsiveContainer,
} from "recharts";

function safeHost(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "";
  }
}

/** Locale for date formatting. Set to 'en-US' for month-first if you prefer. */
const DATE_LOCALE = "en-GB";
const DATE_OPTS = { year: "numeric", month: "short", day: "numeric" };

export default function ProductPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [product, setProduct] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [retailerPrices, setRetailerPrices] = useState([]);
  const [error, setError] = useState("");

  // analysis state
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisSummary, setAnalysisSummary] = useState(null);
  const [analysisError, setAnalysisError] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const res = await api.get(`/analytics/${id}`);

        if (!mounted) return;

        setProduct(res.data.product || null);
        setPriceHistory(res.data.price_history || []);
        setRetailerPrices(res.data.retailer_prices || []);
      } catch (err) {
        console.error(err);
        setError(err?.response?.data?.detail || err.message || "Failed to load product");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [id]);

  // Normalize history rows to { date: Date, price: number, original: ... }
  const normalizedHistory = useMemo(() => {
    if (!Array.isArray(priceHistory)) return [];

    const parseDate = (raw) => {
      if (!raw && raw !== 0) return null;
      const n = Number(raw);
      if (!Number.isNaN(n)) {
        // heuristic: if > 1e12 it's ms, if > 1e10 treat as ms, else seconds
        if (n > 1e12) return new Date(n);
        if (n > 1e10) return new Date(n);
        if (n > 1e9) return new Date(n * 1000);
        return new Date(n);
      }
      try {
        // if ISO-like string with 'T'
        if (String(raw).includes("T")) return new Date(String(raw));
        // try YYYY-MM-DD
        return new Date(`${String(raw)}T00:00:00Z`);
      } catch {
        return null;
      }
    };

    const parsePrice = (p) => {
      if (p == null) return null;
      if (typeof p === "number") return p;
      if (typeof p === "string") {
        const cleaned = p.replace(/[^\d.-]/g, "").trim();
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    const out = priceHistory
      .map((r) => {
        const price =
          r?.price ??
          r?.current_price ??
          r?.value ??
          r?.amount ??
          r?.price_amount ??
          r?.price_value ??
          null;

        const dateRaw = r?.scraped_at ?? r?.tracked_at ?? r?.date ?? r?.timestamp ?? r?.ts ?? r?.created_at ?? null;

        const date = parseDate(dateRaw);
        return { original: r, price: parsePrice(price), date };
      })
      .filter((x) => x.price != null && x.date instanceof Date && !Number.isNaN(x.date.getTime()))
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    return out;
  }, [priceHistory]);

  // chart friendly data
  const chartData = useMemo(() => {
    return normalizedHistory.map((r) => ({
      date: r.date.toLocaleDateString(DATE_LOCALE, DATE_OPTS),
      price: Number(r.price) || 0,
    }));
  }, [normalizedHistory]);

  // stats
  const stats = useMemo(() => {
    if (!normalizedHistory.length) return { min: null, max: null, avg: null, since: null };
    const vals = normalizedHistory.map((r) => Number(r.price));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    const since = normalizedHistory[0].date;
    return { min, max, avg, since };
  }, [normalizedHistory]);

  // choose most reliable "latest" price/date: prefer product.current_price, else last priceHistory entry
  const latestEntry = normalizedHistory.length ? normalizedHistory[normalizedHistory.length - 1] : null;
  const latestPrice = Number(product?.current_price ?? latestEntry?.price ?? product?.price ?? NaN);
  const latestCheckedAt =
    product?.scraped_at ??
    (latestEntry?.date ? latestEntry.date.toISOString() : null) ??
    product?.updated_at ??
    null;


  function formatCurrency(v) {
    if (v === null || v === undefined) return "-";
    const n = Number(v);
    if (Number.isNaN(n)) return "-";
    return `₹${n.toLocaleString()}`;
  }

  // --- Analyze flow (posts to /analyze then polls /analyze/result/{task_id}) ---
  async function handleAnalyzeClick() {
    if (!product) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisSummary(null);

    try {
      const req = {
        product_id: product.product_id ?? product.id ?? id,
        title: product.title ?? "",
        image_url: product.image_url ?? null,
        current_price: Number(product.current_price ?? product.price) || null,
      };

      const enqueue = await api.post("/analyze", req);
      const taskId = enqueue?.data?.task_id;
      if (!taskId) {
        throw new Error("Failed to enqueue analysis");
      }

      // poll for up to 20s
      const timeout = 20000;
      const interval = 1500;
      let elapsed = 0;
      let got = null;
      while (elapsed < timeout) {
        await new Promise((r) => setTimeout(r, interval));
        elapsed += interval;
        try {
          const res = await api.get(`/analyze/result/${taskId}`);
          if (res?.data?.analysis) {
            got = res.data.analysis;
            break;
          }
        } catch {
          // not ready yet
        }
      }

      if (!got) {
        setAnalysisError("Analysis not ready — try again in a few seconds.");
        setAnalyzing(false);
        return;
      }

      // Expect backend/LLM to return an object like:
      // { score: 0-100, summary: "two line text", details: {...} }
      if (typeof got === "object") {
        setAnalysisSummary({
          score: Number(got.score ?? got.score_percent ?? got.score_pct ?? 0),
          summary: got.summary ?? got.text ?? JSON.stringify(got).slice(0, 200),
        });
      } else {
        setAnalysisSummary({ score: 0, summary: String(got).slice(0, 200) });
      }
    } catch (err) {
      console.error("Analyze error:", err);
      setAnalysisError(err?.response?.data?.detail || err.message || "Failed to analyze");
    } finally {
      setAnalyzing(false);
    }
  }

  if (!loading && !product) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-xl font-semibold">Product Not Found</h1>
        <button onClick={() => navigate(-1)} className="px-4 py-2 bg-sky-600 text-white rounded mt-4">
          Go Back
        </button>
      </div>
    );
  }

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      {loading ? (
        <div>Loading…</div>
      ) : error ? (
        <div className="text-red-600">{error}</div>
      ) : (
        <div className="max-w-5xl mx-auto space-y-8">
          {/* Product Panel */}
          <div className="bg-white rounded-lg shadow p-6 flex gap-6 items-start">
            <div className="w-48 h-48 bg-gray-100 rounded flex items-center justify-center overflow-hidden">
              {product?.image_url ? (
                <img src={product.image_url} alt={product.title} className="object-cover w-full h-full" />
              ) : (
                <span>No Image</span>
              )}
            </div>

            <div className="flex-1">
              <h1 className="text-2xl font-bold">{product.title}</h1>
              <p className="text-gray-500">{safeHost(product.url)}</p>

              <div className="mt-4 flex items-center justify-between gap-6">
                <div>
                  <div className="text-sm text-gray-500">Current Price</div>
                  <div className="text-3xl font-bold text-sky-700">
                    {Number.isFinite(latestPrice) ? formatCurrency(latestPrice) : "-"}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    Last checked: {latestCheckedAt ? new Date(latestCheckedAt).toLocaleString() : "-"}
                  </div>
                </div>

                <div className="space-y-2">
                  <button
                    onClick={handleAnalyzeClick}
                    disabled={analyzing}
                    className="px-4 py-2 bg-indigo-600 text-white rounded shadow"
                  >
                    {analyzing ? "Analyzing…" : "Analyze Deal"}
                  </button>

                  {analysisError && <div className="text-red-600 text-sm">{analysisError}</div>}

                  {analysisSummary && (
                    <div className="p-3 bg-gray-50 rounded border">
                      <div className="text-xs text-gray-500">Deal score</div>
                      <div className="text-xl font-semibold">{Math.round(analysisSummary.score)} / 100</div>
                      <div className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{analysisSummary.summary}</div>
                    </div>
                  )}
                </div>
              </div>


              <div className="grid grid-cols-3 gap-4 mt-6">
                <div className="p-3 bg-gray-50 rounded text-center">
                  <div className="text-xs text-gray-500">LOW</div>
                  <div className="text-lg font-semibold text-gray-500">{formatCurrency(stats.min)}</div>
                </div>
                <div className="p-3 bg-gray-50 rounded text-center">
                  <div className="text-xs text-gray-500">AVG</div>
                  <div className="text-lg font-semibold text-gray-500">{stats.avg ? `₹${stats.avg.toFixed(2)}` : "-"}</div>
                </div>
                <div className="p-3 bg-gray-50 rounded text-center">
                  <div className="text-xs text-gray-500">HIGH</div>
                  <div className="text-lg font-semibold text-gray-500">{formatCurrency(stats.max)}</div>
                </div>
              </div>

              <div className="text-xs text-gray-400 mt-2">
                Tracking since: {stats.since ? stats.since.toLocaleDateString(DATE_LOCALE, DATE_OPTS) : "-"}
              </div>
            </div>
          </div>

          {/* Trend Chart */}
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-lg font-semibold mb-4">Price Trend</h2>

            {chartData.length === 0 ? (
              <div>No data available.</div>
            ) : (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis tickFormatter={(v) => `₹${v}`} />
                    <Tooltip formatter={(v) => `₹${Number(v).toLocaleString()}`} />
                    <Area type="monotone" dataKey="price" stroke="#0ea5e9" fill="url(#g2)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Retailers */}
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-lg font-semibold mb-4">Retailer Comparison</h2>

            {retailerPrices.length === 0 ? (
              <div>No retailer data.</div>
            ) : (
              retailerPrices.map((r) => (
                <div key={r.id ?? r.retailer_name} className="flex justify-between p-3 bg-gray-50 rounded mb-2">
                  <span>{r.retailer_name}</span>
                  <span className="font-semibold">{formatCurrency(r.price)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
