// src/pages/TrackerPage.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase.js";
import { useNavigate } from "react-router-dom";
import api from "../lib/api.js";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

function safeHost(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "";
  }
}

function formatCurrency(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return "—";
  return `₹${n.toLocaleString("en-IN")}`;
}

function shortDateFromIso(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  } catch {
    return iso;
  }
}

export default function TrackerPage() {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [priceHistory, setPriceHistory] = useState([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError("");

      // get current user
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData?.user) {
        if (!mounted) return;
        setError("Unable to get current user. Please login.");
        setLoading(false);
        return;
      }
      const userId = userData.user.id;

      try {
        // 1) Fetch user's products from backend
        const prodResp = await api.get("/user/products", {
          params: { user_id: userId },
        });

        const productRows = prodResp?.data?.products || [];
        if (mounted) setProducts(productRows);

        // 2) Fetch price history from dashboard endpoint
        const histResp = await api.get("/dashboard", {
          params: { user_id: userId },
        });

        const rawHistory = histResp?.data?.price_history || [];

        // Normalize different possible shapes to { product_id, price, scraped_at (ISO), _ts }
        const normalized = rawHistory.map((h) => {
          const price =
            h?.price ??
            h?.current_price ??
            h?.value ??
            h?.amount ??
            (typeof h?.price_amount === "number" ? h.price_amount : undefined) ??
            null;

          // convert many date shapes -> ISO
          let scraped_at = null;
          if (h?.scraped_at) {
            scraped_at = String(h.scraped_at);
          } else if (h?.date) {
            scraped_at = String(h.date).includes("T") ? String(h.date) : `${h.date}T00:00:00Z`;
          } else if (h?.timestamp) {
            const ts = Number(h.timestamp);
            if (Number.isFinite(ts)) {
              scraped_at = ts > 1e12 ? new Date(ts / 1000).toISOString() : new Date(ts).toISOString();
            } else {
              scraped_at = String(h.timestamp);
            }
          } else if (h?.ts) {
            const ts = Number(h.ts);
            if (Number.isFinite(ts)) {
              scraped_at = ts > 1e12 ? new Date(ts / 1000).toISOString() : new Date(ts).toISOString();
            } else {
              scraped_at = String(h.ts);
            }
          }

          const tsNum = scraped_at ? new Date(scraped_at).getTime() || 0 : 0;

          return {
            product_id: h?.product_id ?? h?.prod_id ?? h?.pid ?? null,
            price,
            scraped_at, // ISO-ish string when possible
            _ts: tsNum,
            __raw: h,
          };
        });

        const filtered = normalized.filter((r) => r.product_id);
        if (mounted) setPriceHistory(filtered);
      } catch (err) {
        console.error("Tracker load error:", err);
        if (mounted) setError(err?.message || "Failed to load tracker data");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  const historyByProduct = useMemo(() => {
    const map = {};
    for (const r of priceHistory) {
      if (!r || !r.product_id) continue;
      if (!map[r.product_id]) map[r.product_id] = [];
      map[r.product_id].push(r);
    }
    // ensure each list is sorted ascending by scraped_at
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => (a._ts || 0) - (b._ts || 0));
    }
    return map;
  }, [priceHistory]);

  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        (p.title || "").toLowerCase().includes(q) ||
        (p.source || "").toLowerCase().includes(q) ||
        (p.url || "").toLowerCase().includes(q)
    );
  }, [products, search]);

  async function handleAddProduct() {
    const url = window.prompt("Paste product URL to track:");
    if (!url) return;
    const title = window.prompt("Enter a title:", "");

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user.id;

    setAdding(true);
    try {
      await api.post("/user/add_product", {
        user_id: userId,
        product_id: crypto.randomUUID(),
        title: title || "New product",
        url: encodeURI(url),
        image_url: null,
        current_price: null,
        source: safeHost(url),
      });

      alert("Product added! Scraper will update it soon.");
      // ideally refetch; quick reload for now
      window.location.reload();
    } catch (err) {
      console.error("Add product error:", err);
      alert(err?.message || "Failed to add product.");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveProduct(id) {
    const ok = window.confirm("Remove this tracked product?");
    if (!ok) return;

    const { data: userData } = await supabase.auth.getUser();

    try {
      await api.delete(`/user/remove_product/${userData.user.id}/${id}`);
      setProducts((prev) => prev.filter((p) => p.product_id !== id));
    } catch (err) {
      console.error("Remove product error:", err);
      alert(err?.message || "Failed to delete product.");
    }
  }

  // Small sparkline component (mini area)
  function SmallSparkline({ points }) {
    if (!points || points.length < 2) {
      return <div className="text-xs text-gray-400">No data</div>;
    }

    const data = points
      .slice(-12)
      .map((r) => {
        const dateIso = r.scraped_at
          ? (String(r.scraped_at).includes("T") ? String(r.scraped_at) : `${r.scraped_at}T00:00:00Z`)
          : (r._ts ? new Date(r._ts).toISOString() : "");

        const priceVal = r.price ?? r.current_price ?? (r.__raw && (r.__raw.price ?? r.__raw.current_price ?? r.__raw.amount)) ?? 0;

        return {
          date: dateIso,
          price: Number(priceVal) || 0,
          _ts: r._ts || (dateIso ? new Date(dateIso).getTime() : 0),
        };
      })
      .filter((d) => d.date);

    if (!data.length) return <div className="text-xs text-gray-400">No data</div>;

    data.sort((a, b) => a._ts - b._ts);

    return (
      <div className="h-16">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#34d399" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} horizontal={false} />
            <XAxis dataKey="date" hide />
            <YAxis hide />
            <Tooltip
              labelFormatter={(iso) => {
                try {
                  return new Date(iso).toLocaleDateString("en-GB");
                } catch {
                  return iso;
                }
              }}
              formatter={(v) => formatCurrency(v)}
            />
            <Area type="monotone" dataKey="price" stroke="#10b981" fill="url(#spark)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">My Tracker</h1>
            <p className="text-sm text-gray-500">Monitor prices across different stores.</p>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="search"
              placeholder="Search tracked products..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-4 py-2 w-96 border rounded-md focus:outline-none focus:ring-2 focus:ring-sky-300"
            />
            <button
              onClick={handleAddProduct}
              disabled={adding}
              className="bg-sky-600 text-white px-4 py-2 rounded-md shadow hover:bg-sky-700"
            >
              + Add Product
            </button>
          </div>
        </div>

        {/* Grid of product cards */}
        {loading ? (
          <div>Loading…</div>
        ) : error ? (
          <div className="text-red-600">{error}</div>
        ) : visibleProducts.length === 0 ? (
          <div className="text-gray-600">No tracked products. Add one to get started.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleProducts.map((p) => {
              const hist = historyByProduct[p.product_id] || [];
              const lastHist = hist.length ? hist[hist.length - 1] : null;
              const prevHist = hist.length >= 2 ? hist[hist.length - 2] : null;

              const lastPrice = p.current_price ?? (lastHist ? lastHist.price : null) ?? 0;
              const prevPrice = prevHist ? prevHist.price : null;

              // compute simple "save" compared to historical highest or prev
              const highest = p.highest_price ?? (hist.length ? Math.max(...hist.map((r) => Number(r.price) || 0)) : null);
              const savePct = highest ? Math.max(0, Math.round(((highest - Number(lastPrice)) / highest) * 100)) : 0;

              // last-updated friendly text
              const lastUpdatedIso = (lastHist && lastHist.scraped_at) || p.scraped_at || p.added_at || null;
              const lastUpdatedLabel = lastUpdatedIso ? `Updated ${shortDateFromIso(lastUpdatedIso)}` : "Updated recently";

              return (
                <article key={p.product_id} className="bg-white rounded-lg shadow-sm overflow-hidden">
                  {/* image area */}
                  <div className="bg-gray-50 p-4 flex items-center justify-center h-44">
                    <img
                      src={p.image_url || "/placeholder-product.png"}
                      alt={p.title}
                      className="object-cover h-full w-full max-w-xs rounded"
                      style={{ maxHeight: 180 }}
                    />
                    {/* top-right status badge */}
                    <span className="absolute right-6 top-8 bg-emerald-100 text-emerald-800 text-xs px-2 py-1 rounded-full shadow-sm">Active</span>
                  </div>

                  {/* card body */}
                  <div className="p-5">
                    <h3 className="text-lg font-semibold text-gray-800">{p.title}</h3>
                    <p className="text-xs text-gray-500 mt-1">{safeHost(p.url) || p.source}</p>

                    <div className="flex items-center justify-between mt-4">
                      <div>
                        <div className="text-xs text-gray-400">CURRENT PRICE</div>
                        <div className={`text-2xl font-bold ${savePct > 0 ? "text-emerald-600" : "text-gray-900"}`}>
                          {formatCurrency(lastPrice)}
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="inline-block bg-emerald-50 text-emerald-700 text-xs px-2 py-1 rounded-full">
                          Save {savePct}% 
                        </div>
                      </div>
                    </div>

                    <div className="mt-4">
                      <SmallSparkline points={hist} />
                    </div>

                    <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center text-xs text-gray-400">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M3 12h18M3 6h18M3 18h18" /></svg>
                          {lastUpdatedLabel}
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => navigate(`/product/${p.product_id}`)}
                          className="px-3 py-1 ring-1 ring-gray-200 rounded text-sm bg-white hover:bg-gray-50"
                        >
                          Details
                        </button>
                        <button
                          onClick={() => handleRemoveProduct(p.product_id)}
                          className="px-2 py-1 text-red-600 hover:underline text-sm"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline-block" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
