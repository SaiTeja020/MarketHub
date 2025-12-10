// src/pages/AnalyticsPage.jsx
import { useEffect, useState, useMemo } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabase.js";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import api from "../lib/api.js";

export default function AnalyticsPage() {
  const { id } = useParams(); // may be undefined

  const [resolvedId, setResolvedId] = useState(id || null);
  const [loading, setLoading] = useState(true);
  const [product, setProduct] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [retailerPrices, setRetailerPrices] = useState([]);
  const [error, setError] = useState("");

  // products for selector
  const [products, setProducts] = useState([]);

  // analysis UI state
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisSummary, setAnalysisSummary] = useState(null);
  const [analysisError, setAnalysisError] = useState(null);

  // --- Normalize price history into consistent { date, price } objects ---
  const normalizedHistory = useMemo(() => {
    if (!Array.isArray(priceHistory)) return [];

    const parseDate = (raw) => {
      if (!raw) return null;
      const n = Number(raw);
      if (!Number.isNaN(n)) {
        // heuristics: seconds vs ms
        if (n > 1e12) return new Date(n);
        if (n > 1e10) return new Date(n);
        if (n > 1e9) return new Date(n * 1000);
        return new Date(n);
      }
      try {
        if (String(raw).includes("T")) return new Date(String(raw));
        return new Date(`${String(raw)}T00:00:00Z`);
      } catch {
        return null;
      }
    };

    const parsePrice = (p) => {
      if (p == null) return null;
      if (typeof p === "number") return p;
      if (typeof p === "string") {
        const cleaned = p.replace(/[^\d.-]/g, "");
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    return priceHistory
      .map((r) => {
        const price =
          r?.price ??
          r?.current_price ??
          r?.value ??
          r?.amount ??
          r?.price_amount ??
          null;

        const dateRaw =
          r?.scraped_at ??
          r?.tracked_at ??
          r?.date ??
          r?.timestamp ??
          null;

        const date = parseDate(dateRaw);
        return { price: parsePrice(price), date };
      })
      .filter((x) => x.price != null && x.date instanceof Date && !Number.isNaN(x.date.getTime()))
      .sort((a, b) => a.date - b.date);
  }, [priceHistory]);

  // Fetch user's tracked products (populate selector). Run once on mount or when route id changes
  useEffect(() => {
    let mounted = true;
    async function fetchProducts() {
      try {
        const {
          data: { user },
          error: userErr,
        } = await supabase.auth.getUser();

        if (userErr || !user) {
          if (!mounted) return;
          setProducts([]);
          return;
        }

        const dashResp = await api.get("/dashboard", {
          params: { user_id: user.id },
        });

        const prods = dashResp?.data?.products || [];
        if (!mounted) return;
        setProducts(prods);
      } catch (err) {
        console.error("Failed to fetch products for selector:", err);
        if (!mounted) return;
        setProducts([]);
      }
    }

    fetchProducts();
    return () => {
      mounted = false;
    };
  }, [id]);

  // Resolve id if not provided in route (pick first tracked product for user)
  useEffect(() => {
    let mounted = true;
    async function resolve() {
      setLoading(true);
      setError("");
      try {
        if (id) {
          setResolvedId(id);
          setLoading(false);
          return;
        }

        const {
          data: { user },
          error: userErr,
        } = await supabase.auth.getUser();

        if (userErr || !user) {
          if (!mounted) return;
          setError("Unable to get current user. Please login.");
          setLoading(false);
          return;
        }

        const dashResp = await api.get("/dashboard", {
          params: { user_id: user.id },
        });

        const prods = dashResp?.data?.products || [];
        if (!prods || prods.length === 0) {
          if (!mounted) return;
          setError("You don't have any tracked products yet. Add one from My Tracker.");
          setLoading(false);
          return;
        }

        const pick = prods[0].product_id || prods[0].id || null;
        if (!pick) {
          if (!mounted) return;
          setError("No valid product id available for your tracked products.");
          setLoading(false);
          return;
        }

        if (mounted) setResolvedId(pick);
      } catch (err) {
        console.error("Analytics resolve error:", err);
        if (!mounted) return;
        setError(err?.response?.data?.detail || err?.message || "Failed to resolve product id.");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    resolve();
    return () => {
      mounted = false;
    };
  }, [id]);

  // Load analytics when resolvedId is set
  useEffect(() => {
    if (!resolvedId) return;
    let mounted = true;
    async function loadAnalytics() {
      setLoading(true);
      setError("");
      try {
        const res = await api.get(`/analytics/${resolvedId}`);

        if (!mounted) return;
        setProduct(res.data.product || null);
        setPriceHistory(res.data.price_history || []);
        setRetailerPrices(res.data.retailer_prices || []);
      } catch (err) {
        console.error("Failed to load analytics for", resolvedId, err);
        if (!mounted) return;
        setError(err?.response?.data?.detail || err?.message || "Failed to load analytics.");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadAnalytics();
    return () => {
      mounted = false;
    };
  }, [resolvedId]);

  // Normalize chart data and numeric prices.
  const chartData = useMemo(() => {
    if (!priceHistory || !priceHistory.length) return [];
    const transformed = priceHistory
      .map((p) => {
        const rawDate =
          p.scraped_at ?? p.tracked_at ?? p.date ?? p.timestamp ?? p.ts ?? null;

        let iso = null;
        if (!rawDate) {
          iso = null;
        } else if (typeof rawDate === "number") {
          iso = new Date(rawDate).toISOString();
        } else if (typeof rawDate === "string" && /^\d{10}$/.test(rawDate)) {
          iso = new Date(Number(rawDate) * 1000).toISOString();
        } else if (typeof rawDate === "string" && /^\d+$/.test(rawDate)) {
          iso = new Date(Number(rawDate)).toISOString();
        } else {
          const d = new Date(rawDate);
          if (!Number.isNaN(d.getTime())) iso = d.toISOString();
          else iso = null;
        }

        const price = Number(p.price ?? p.current_price ?? p.amount ?? p.value ?? 0) || 0;

        return {
          iso,
          dateLabel: iso ? new Date(iso).toLocaleDateString() : "",
          price,
        };
      })
      .filter((d) => d.iso)
      .sort((a, b) => new Date(a.iso) - new Date(b.iso))
      .map((d) => ({ date: d.dateLabel, price: d.price }));

    return transformed;
  }, [priceHistory]);

  // Compute min, avg, max from the chartData (defensive)
  const { minPrice, avgPrice, maxPrice } = useMemo(() => {
    const prices = chartData.map((d) => Number(d.price)).filter((n) => Number.isFinite(n));
    if (!prices.length) return { minPrice: null, avgPrice: null, maxPrice: null };
    const sum = prices.reduce((s, v) => s + v, 0);
    const avg = sum / prices.length;
    const mn = Math.min(...prices);
    const mx = Math.max(...prices);
    return { minPrice: mn, avgPrice: avg, maxPrice: mx };
  }, [chartData]);

  function formatCurrency(v) {
    if (v === null || v === undefined) return "—";
    const n = Number(v);
    if (Number.isNaN(n)) return "—";
    return `₹${n.toLocaleString(undefined, {
      maximumFractionDigits: 2,
      minimumFractionDigits: 0,
    })}`;
  }

  // handler for product change from selector (also updates URL)
  function handleProductChange(nextId) {
    if (!nextId) return;
    setResolvedId(nextId);

    try {
      const newUrl = `/analytics/${nextId}`;
      window.history.pushState({}, "", newUrl);
    } catch (e) {
      console.warn("Failed to update URL with history API:", e);
    }
  }

  // small helper to normalize an analysis object into { score, summary } safe for UI
  function normalizeAnalysisForUI(raw) {
    if (!raw) return { score: 0, summary: "No analysis result." };

    // If raw is a JSON string, try parse
    if (typeof raw === "string") {
      // guard: sometimes the backend stored an httpx.HTTPError string — treat as error
      if (raw.toLowerCase().includes("client error") || raw.toLowerCase().includes("http")) {
        return { score: 0, summary: raw };
      }
      try {
        raw = JSON.parse(raw);
      } catch {
        // leave as plain string
        return { score: 0, summary: String(raw) };
      }
    }

    // if it's an object, try to find score and summary/text
    if (typeof raw === "object") {
      const scoreCandidates = [
        raw.score,
        raw.score_percent,
        raw.credibility_score,
        raw.confidence,
        raw.confidence_score,
      ];
      let score = null;
      for (const s of scoreCandidates) {
        if (s == null) continue;
        const n = Number(String(s).replace("%", "").trim());
        if (!Number.isNaN(n)) {
          score = n;
          break;
        }
      }
      if (score == null) score = 0;
      // if score in 0..1, scale to 0..100
      if (score > 0 && score <= 1) score = score * 100;

      const summary =
        raw.summary ??
        raw.text ??
        raw.excerpt ??
        (typeof raw.raw_response === "string" ? raw.raw_response : JSON.stringify(raw.raw_response ?? raw).slice(0, 1000));

      return { score: Number(score || 0), summary: String(summary ?? "").trim() || "No summary." };
    }

    // fallback
    return { score: 0, summary: String(raw) };
  }

  // ---- Analysis flow (direct call to deterministic endpoint) ----
  async function handleAnalyzeClick() {
    if (!product) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisSummary(null);

    try {
      const req = {
        product_id: product.product_id ?? product.id ?? resolvedId,
        title: product.title ?? "",
        image_url: product.image_url ?? null,
        current_price: Number(product.current_price ?? product.price),
        history: normalizedHistory.map((h) => h.price),
      };

      console.log("Enqueueing analysis request:", req);

      // enqueue job (your existing queue endpoint)
      const enqueueResp = await api.post("/analyze", req);
      console.log("Enqueue response:", enqueueResp?.data);

      const taskId = enqueueResp?.data?.task_id ?? enqueueResp?.data?.id ?? null;
      const initialStatus = enqueueResp?.data?.status ?? null;

      // Fast path: backend returned analysis in same response (sync)
      if (enqueueResp?.data?.analysis) {
        const got = enqueueResp.data.analysis;
        const ui = normalizeAnalysisForUI(got);
        setAnalysisSummary(ui);
        setAnalyzing(false);
        return;
      }

      // Another fast path: backend returns analysis-like object directly
      if (enqueueResp?.data && (enqueueResp.data.score || enqueueResp.data.summary || enqueueResp.data.text)) {
        const ui = normalizeAnalysisForUI(enqueueResp.data);
        setAnalysisSummary(ui);
        setAnalyzing(false);
        return;
      }

      if (!taskId) {
        throw new Error("Failed to enqueue analysis (no task_id returned)");
      }

      // Poll for result (short timeout for UX)
      const timeoutMs = 20000; // total poll window
      const intervalMs = 1500;
      let elapsed = 0;
      let final = null;

      while (elapsed < timeoutMs) {
        await new Promise((r) => setTimeout(r, intervalMs));
        elapsed += intervalMs;

        try {
          const res = await api.get(`/analyze/result/${taskId}`);
          console.log("Poll response:", res?.data);

          // possible shapes:
          // { analysis: {...} }
          if (res?.data?.analysis) {
            final = res.data.analysis;
            break;
          }
          // { status:'done', result: {...} }
          if (res?.data?.status === "done" && res?.data?.result) {
            final = res.data.result;
            break;
          }
          // { task_id, analysis: {...} } or { task_id, analysis: "..." }
          if (res?.data && (res.data.result || res.data.analysis)) {
            final = res.data.result ?? res.data.analysis;
            break;
          }

          // if the endpoint returned a plain object with summary/score
          if (res?.data && (res.data.score || res.data.summary || res.data.text)) {
            final = res.data;
            break;
          }

        } catch (err) {
          // often 404 while job not ready; keep retrying silently
          console.warn("Poll failed (will retry):", err?.response?.status, err?.message);
        }
      }

      if (!final) {
        setAnalysisError("Analysis not ready — worker may be offline or taking longer. Try again in a few seconds.");
        setAnalyzing(false);
        return;
      }

      const ui = normalizeAnalysisForUI(final);
      // If the summary seems to contain raw HTTP error info (from backend), show friendly error
      if (ui.summary && /client error|http.*404|not found/i.test(ui.summary)) {
        setAnalysisError(ui.summary);
        setAnalyzing(false);
        return;
      }

      setAnalysisSummary(ui);
    } catch (err) {
      console.error("Analyze error:", err);
      setAnalysisError(
        err?.response?.data?.error ||
          err?.response?.data?.detail ||
          err?.message ||
          "Failed to analyze"
      );
    } finally {
      setAnalyzing(false);
    }
  }

  // ---- UI states ----
  if (loading) {
    return (
      <div className="p-8 bg-gray-50 min-h-screen">
        <div className="text-gray-500">Loading analytics…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 bg-gray-50 min-h-screen">
        <div className="text-red-600">{error}</div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="p-8 bg-gray-50 min-h-screen">
        <div className="text-gray-600">No product found.</div>
      </div>
    );
  }

  // ---------------- RENDER ----------------
  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Analytics — {product.title}</h1>

        {/* Product selector + Analyze button */}
        <div className="flex items-center gap-3">
          <div>
            <label className="text-xs text-gray-500 mr-2">Product</label>
            <select
              value={resolvedId ?? ""}
              onChange={(e) => handleProductChange(e.target.value)}
              className="border rounded px-3 py-1 bg-white text-black"
            >
              {products && products.length > 0 ? (
                <>
                  <option value="" disabled>
                    Select product
                  </option>
                  {products.map((p) => {
                    const pid = p.product_id ?? p.id;
                    const label = p.title ?? p.name ?? p.product_name ?? pid;
                    return (
                      <option key={pid} value={pid}>
                        {label}
                      </option>
                    );
                  })}
                </>
              ) : (
                <option value={resolvedId}>{product.title}</option>
              )}
            </select>
          </div>

          <div>
            <button
              onClick={handleAnalyzeClick}
              disabled={analyzing}
              className="px-4 py-2 bg-indigo-600 text-white rounded shadow"
            >
              {analyzing ? "Analyzing…" : "Analyze Deal"}
            </button>
          </div>
        </div>
      </div>

      {/* Chart + metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 text-gray-800">Price Trend</h2>

          {chartData.length === 0 ? (
            <div className="text-gray-500 text-sm">No price history available.</div>
          ) : (
            <div className="w-full h-72">
              <ResponsiveContainer width="100%" height="100%" key={resolvedId}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>

                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis tickFormatter={(v) => `₹${v}`} />
                  <Tooltip formatter={(v) => formatCurrency(v)} />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke="#2563eb"
                    fill="url(#g2)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Metrics row: LOW / AVG / HIGH */}
          <div className="mt-6 grid grid-cols-3 gap-3">
            <MetricCard label="LOW" value={formatCurrency(minPrice)} />
            <MetricCard label="AVG" value={formatCurrency(avgPrice)} />
            <MetricCard label="HIGH" value={formatCurrency(maxPrice)} />
          </div>
        </div>

        {/* Right column: retailer comparison + analysis summary */}
        <div className="bg-white rounded-lg shadow-sm p-6 space-y-4">
          {/* Analysis summary panel */}
          <div>
            <h3 className="text-sm text-gray-600 mb-2">Price Analysis</h3>

            {analysisError && <div className="text-red-600 text-sm mb-2">{analysisError}</div>}

            {!analysisSummary && !analysisError && (
              <div className="text-sm text-gray-500">No analysis yet — click "Analyze Deal" to run it.</div>
            )}

            {analysisSummary && (
              <div className="p-3 bg-gray-50 rounded border">
                <div className="text-xs text-gray-500">Deal score</div>
                <div className="text-xl font-semibold text-gray-900">{Math.round(analysisSummary.score)} / 100</div>
                <div className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{analysisSummary.summary}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* small presentational metric card */
function MetricCard({ label, value }) {
  return (
    <div className="bg-gray-50 border rounded p-3 text-center">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold mt-1 text-gray-900">{value}</div>
    </div>
  );
}
