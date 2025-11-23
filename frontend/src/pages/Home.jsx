import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase.js";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts";

/**
 * Dashboard (Home) page
 *
 * - Fetches the current user, products, and price_history from Supabase
 * - Calculates:
 *   - tracked products count
 *   - price drops in last 24h (compares latest vs previous price per product)
 *   - avg saving (based on lowest_price vs current_price across tracked items)
 * - Shows Recent Price Changes list (latest delta per product)
 * - Shows Featured Trend (30-day history) for the top changed product (fallback placeholder)
 *
 * NOTE: this expects the following tables and fields (as discussed earlier):
 * - products(id, user_id, title, url, image_url, current_price, lowest_price, highest_price, created_at)
 * - price_history(id, product_id, price, tracked_at)
 *
 * The uploaded screenshot is used as a fallback/placeholder image:
 * /mnt/data/Screenshot 2025-11-23 223800.png
 */

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [priceHistory, setPriceHistory] = useState([]); // array of { product_id, price, tracked_at }
  const [error, setError] = useState("");
  const [featuredProductId, setFeaturedProductId] = useState(null);

  // fetch everything on mount
  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError("");

      // Get current user
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user) {
        setError("Unable to get current user. Please login again.");
        setLoading(false);
        return;
      }

      const userId = user.id;

      try {
        // 1) fetch products for user
        const { data: productsData, error: prodErr } = await supabase
          .from("products")
          .select(
            `id, title, url, image_url, current_price, lowest_price, highest_price, created_at`
          )
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (prodErr) throw prodErr;

        // gather product ids
        const productIds = (productsData || []).map((p) => p.id);
        let priceHistoryData = [];

        if (productIds.length) {
          // 2) fetch recent price history for these products (last 90 days or all)
          // we'll fetch last 90 entries per product by retrieving all and trimming client-side
          const { data: phData, error: phErr } = await supabase
            .from("price_history")
            .select("id, product_id, price, tracked_at")
            .in("product_id", productIds)
            .order("tracked_at", { ascending: true }); // ascending for timeseries

          if (phErr) throw phErr;
          priceHistoryData = phData || [];
        }

        if (!mounted) return;
        setProducts(productsData || []);
        setPriceHistory(priceHistoryData || []);

        // pick featured product: choose product with largest absolute % change in last 30 days (fallback to first)
        const productChangeScores = {};
        const now = new Date();
        const ms30 = 30 * 24 * 60 * 60 * 1000;

        productsData.forEach((p) => {
          const phForP = priceHistoryData.filter((r) => r.product_id === p.id);
          if (phForP.length >= 2) {
            // find earliest point within last 30 days (or earliest available)
            const cutoff = new Date(now - ms30);
            const recentPoints = phForP.filter(
              (r) => new Date(r.tracked_at) >= cutoff
            );

            // if no recentPoints, compare first and last
            const baseline = recentPoints.length
              ? recentPoints[0].price
              : phForP[0].price;
            const latest = phForP[phForP.length - 1].price;

            // guard numeric
            const baselineN = Number(baseline) || 0;
            const latestN = Number(latest) || 0;
            const pct =
              baselineN === 0 ? Math.abs(latestN) : Math.abs((latestN - baselineN) / baselineN);

            productChangeScores[p.id] = pct;
          } else {
            productChangeScores[p.id] = 0;
          }
        });

        // choose highest score
        const entries = Object.entries(productChangeScores);
        if (entries.length) {
          entries.sort((a, b) => b[1] - a[1]);
          setFeaturedProductId(entries[0][0]);
        } else if (productsData[0]) {
          setFeaturedProductId(productsData[0].id);
        }

        setLoading(false);
      } catch (err) {
        console.error(err);
        setError(err.message || "Failed to load dashboard data.");
        setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, []);

  // derived calculations

  // tracked products count
  const trackedCount = products.length;

  // compute latest price per product and previous price to detect drops
  const latestByProduct = useMemo(() => {
    const map = {};
    // priceHistory is ascending by tracked_at
    priceHistory.forEach((r) => {
      map[r.product_id] = map[r.product_id] || [];
      map[r.product_id].push(r);
    });

    const result = {};
    for (const pid of Object.keys(map)) {
      const arr = map[pid];
      const latest = arr[arr.length - 1];
      const prev = arr.length >= 2 ? arr[arr.length - 2] : null;
      result[pid] = { latest, prev, all: arr };
    }
    return result;
  }, [priceHistory]);

  // price drops in last 24h: count products where latest price < price 24h ago (we'll compare last two points and ensure one is within 24h)
  const priceDropsLast24h = useMemo(() => {
    const now = Date.now();
    let count = 0;
    for (const p of products) {
      const info = latestByProduct[p.id];
      if (!info || !info.latest) continue;
      const latestTime = new Date(info.latest.tracked_at).getTime();
      if (!info.prev) continue;
      const prevTime = new Date(info.prev.tracked_at).getTime();
      const elapsed = now - prevTime;
      // only consider if prev point was within last 24h (86400000 ms)
      if (elapsed <= 24 * 60 * 60 * 1000) {
        const latestPrice = Number(info.latest.price) || 0;
        const prevPrice = Number(info.prev.price) || 0;
        if (latestPrice < prevPrice) count += 1;
      }
    }
    return count;
  }, [products, latestByProduct]);

  // avg saving: average of ((highest_price - current_price) / highest_price) across products, expressed percent (guard divide-by-zero)
  const avgSavingPct = useMemo(() => {
    if (!products.length) return 0;
    let totalPct = 0;
    let count = 0;
    products.forEach((p) => {
      const highest = Number(p.highest_price) || 0;
      const current = Number(p.current_price) || 0;
      if (highest > 0) {
        const pct = ((highest - current) / highest) * 100;
        totalPct += pct;
        count++;
      }
    });
    if (!count) return 0;
    return +(totalPct / count).toFixed(2);
  }, [products]);

  // Recent price changes list (sorted by latest tracked_at desc)
  const recentChanges = useMemo(() => {
    const arr = [];
    products.forEach((p) => {
      const info = latestByProduct[p.id];
      if (!info || !info.latest) {
        // no history, use current price
        arr.push({
          product: p,
          latestPrice: Number(p.current_price) || 0,
          prevPrice: null,
          trend: "neutral",
          tracked_at: p.created_at,
        });
        return;
      }
      const latest = Number(info.latest.price) || 0;
      const prev = info.prev ? Number(info.prev.price) || 0 : null;
      let trend = "neutral";
      if (prev !== null) {
        if (latest < prev) trend = "down";
        else if (latest > prev) trend = "up";
      }

      arr.push({
        product: p,
        latestPrice: latest,
        prevPrice: prev,
        trend,
        tracked_at: info.latest.tracked_at,
      });
    });

    // sort by tracked_at desc
    arr.sort((a, b) => new Date(b.tracked_at) - new Date(a.tracked_at));
    return arr.slice(0, 6); // show top 6
  }, [products, latestByProduct]);

  // featured product history (last 30 points) for chart
  const featuredHistory = useMemo(() => {
    if (!featuredProductId) return [];
    const info = latestByProduct[featuredProductId];
    if (!info) return [];
    const arr = info.all || [];
    // take last 30 entries
    const last30 = arr.slice(Math.max(arr.length - 30, 0));
    // map to chart-friendly objects { date, price }
    return last30.map((r) => ({
      date: new Date(r.tracked_at).toLocaleDateString(),
      price: Number(r.price) || 0,
    }));
  }, [featuredProductId, latestByProduct]);

  // featured product metadata
  const featuredProduct = useMemo(
    () => products.find((p) => p.id === featuredProductId) || null,
    [products, featuredProductId]
  );

  // image fallback (use uploaded screenshot path)
  const placeholderImage = "/mnt/data/Screenshot 2025-11-23 223800.png";

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500">
            Welcome back! Here's today's market overview.
          </p>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white p-6 rounded-lg shadow-sm flex justify-between items-center">
            <div>
              <p className="text-xs text-gray-500">Tracked Products</p>
              <p className="text-2xl font-semibold text-gray-900">{trackedCount}</p>
              <p className="text-xs text-green-600 mt-1">Active monitors</p>
            </div>
            <div className="p-2 bg-slate-50 rounded-full">
              {/* bell icon */}
              <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm flex justify-between items-center">
            <div>
              <p className="text-xs text-gray-500">Price Drops</p>
              <p className="text-2xl font-semibold text-gray-900">{priceDropsLast24h}</p>
              <p className="text-xs text-green-600 mt-1">In the last 24h</p>
            </div>
            <div className="p-2 bg-slate-50 rounded-full">
              {/* down arrow */}
              <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 17l-5-5m0 0l5-5m-5 5h12" />
              </svg>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm flex justify-between items-center">
            <div>
              <p className="text-xs text-gray-500">Avg. Saving</p>
              <p className="text-2xl font-semibold text-gray-900">{avgSavingPct}%</p>
              <p className="text-xs text-gray-500 mt-1">Across tracked items</p>
            </div>
            <div className="p-2 bg-slate-50 rounded-full">
              {/* percent icon */}
              <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 12a6 6 0 11-12 0 6 6 0 0112 0zM21 3l-6 6" />
              </svg>
            </div>
          </div>
        </div>

        {/* Main content two columns */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Recent Price Changes */}
          <div className="bg-white rounded-lg shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">Recent Price Changes</h3>
              <a href="/tracker" className="text-sm text-sky-600">View All</a>
            </div>

            {loading ? (
              <div className="space-y-4">
                <div className="h-16 bg-gray-100 rounded" />
                <div className="h-16 bg-gray-100 rounded" />
                <div className="h-16 bg-gray-100 rounded" />
              </div>
            ) : error ? (
              <p className="text-sm text-red-600">{error}</p>
            ) : recentChanges.length === 0 ? (
              <p className="text-sm text-gray-600">No tracked products yet.</p>
            ) : (
              <div className="space-y-3">
                {recentChanges.map((item) => (
                  <div key={item.product.id} className="flex items-center justify-between p-3 rounded border border-gray-100">
                    <div className="flex items-center space-x-3">
                      <img
                        src={item.product.image_url || placeholderImage}
                        alt={item.product.title}
                        className="h-12 w-12 rounded object-cover"
                      />
                      <div>
                        <div className="text-sm font-semibold text-gray-900">
                          {item.product.title}
                        </div>
                        <div className="text-xs text-gray-500">{new URL(item.product.url || "https://example.com").hostname.replace("www.", "")}</div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className={`text-sm font-semibold ${item.trend === "down" ? "text-green-600" : item.trend === "up" ? "text-red-600" : "text-gray-900"}`}>
                        ₹{Number(item.latestPrice).toLocaleString()}
                        {item.trend === "down" ? " ↓" : item.trend === "up" ? " ↑" : ""}
                      </div>
                      {item.prevPrice !== null && (
                        <div className="text-xs text-gray-400 line-through">
                          ₹{Number(item.prevPrice).toLocaleString()}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: Featured Trend */}
          <div className="bg-white rounded-lg shadow-sm p-6 flex flex-col">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-medium text-gray-900">
                  Featured Trend
                </h3>
                <div className="text-sm text-gray-500">
                  {featuredProduct ? featuredProduct.title : "—"}
                </div>
              </div>
              <div className="text-sm text-sky-600">
                30 Day History
              </div>
            </div>

            <div className="flex-1 min-h-[220px]">
              {loading ? (
                <div className="h-56 bg-gray-100 rounded" />
              ) : featuredHistory.length === 0 ? (
                <div className="h-56 flex items-center justify-center">
                  <div className="text-sm text-gray-500">No history to show</div>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={featuredHistory}>
                    <defs>
                      <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="#38bdf8" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={(v) => `₹${v}`} />
                    <Tooltip formatter={(value) => `₹${Number(value).toLocaleString()}`} />
                    <Area type="monotone" dataKey="price" stroke="#0284c7" fill="url(#colorPrice)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="text-sm text-gray-500">Showing latest 30 points</div>
              <a
                href={featuredProduct?.url || "#"}
                target="_blank"
                rel="noreferrer"
                className="text-sky-600 text-sm"
              >
                Open product
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
