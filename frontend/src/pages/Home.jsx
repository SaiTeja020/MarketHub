import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase.js";
import api from "../lib/api.js";

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

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [priceHistory, setPriceHistory] = useState([]);
  const [error, setError] = useState("");
  const [featuredProductId, setFeaturedProductId] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError("");

      // 1) get user via Supabase Auth (auth only)
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user) {
        setError("Unable to get current user. Please login again.");
        setLoading(false);
        return;
      }

      try {
        // 2) fetch dashboard data from backend
        const resp = await api.get("/dashboard", {
          params: { user_id: user.id },
        });

        if (!mounted) return;

        const prods = resp.data.products || [];
        const hist = resp.data.price_history || [];

        setProducts(prods);
        setPriceHistory(hist);

        // ----- Featured Product Calculation -----
        const productChangeScores = {};
        const now = new Date();
        const cutoff30 = new Date(now - 30 * 24 * 60 * 60 * 1000);

        prods.forEach((p) => {
          const ph = hist.filter((r) => r.product_id === p.product_id);
          if (ph.length < 2) {
            productChangeScores[p.product_id] = 0;
            return;
          }

          const recent = ph.filter((r) => new Date(r.scraped_at) >= cutoff30);
          const baseline = recent.length ? recent[0].price : ph[0].price;
          const latest = ph[ph.length - 1].price;

          const base = Number(baseline) || 0;
          const last = Number(latest) || 0;
          const pct = base === 0 ? Math.abs(last) : Math.abs((last - base) / base);

          productChangeScores[p.product_id] = pct;
        });

        const sorted = Object.entries(productChangeScores).sort(
          (a, b) => b[1] - a[1]
        );

        if (sorted.length > 0) {
          setFeaturedProductId(sorted[0][0]);
        } else if (prods[0]) {
          setFeaturedProductId(prods[0].product_id);
        }

        setLoading(false);
      } catch (err) {
        console.error(err);
        setError(err.message || "Failed to load dashboard data");
        setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  // -------- Derived Values ---------

  const trackedCount = products.length;

  const latestByProduct = useMemo(() => {
    const map = {};
    priceHistory.forEach((h) => {
      if (!map[h.product_id]) map[h.product_id] = [];
      map[h.product_id].push(h);
    });

    const out = {};
    for (const pid in map) {
      const arr = map[pid];
      out[pid] = {
        all: arr,
        latest: arr[arr.length - 1],
        prev: arr.length >= 2 ? arr[arr.length - 2] : null,
      };
    }
    return out;
  }, [priceHistory]);

  const priceDropsLast24h = useMemo(() => {
    let count = 0;
    const now = Date.now();

    products.forEach((p) => {
      const info = latestByProduct[p.product_id];
      if (!info || !info.latest || !info.prev) return;

      const prevTime = new Date(info.prev.scraped_at).getTime();
      if (now - prevTime <= 86400000) {
        const latest = Number(info.latest.price) || 0;
        const prev = Number(info.prev.price) || 0;
        if (latest < prev) count++;
      }
    });

    return count;
  }, [products, latestByProduct]);

  const avgSavingPct = useMemo(() => {
    if (!products.length) return 0;

    let total = 0;
    let count = 0;

    products.forEach((p) => {
      const highest = Number(p.highest_price) || 0;
      const current = Number(p.current_price) || 0;
      if (highest > 0) {
        total += ((highest - current) / highest) * 100;
        count++;
      }
    });

    return count ? +(total / count).toFixed(2) : 0;
  }, [products]);

  const recentChanges = useMemo(() => {
    const arr = [];

    products.forEach((p) => {
      const info = latestByProduct[p.product_id];

      if (!info || !info.latest) {
        arr.push({
          product: p,
          latestPrice: Number(p.current_price) || 0,
          prevPrice: null,
          trend: "neutral",
          tracked_at: p.scraped_at,
        });
        return;
      }

      const latest = Number(info.latest.price) || 0;
      const prev = info.prev ? Number(info.prev.price) || 0 : null;

      let trend = "neutral";
      if (prev != null) {
        if (latest < prev) trend = "down";
        else if (latest > prev) trend = "up";
      }

      arr.push({
        product: p,
        latestPrice: latest,
        prevPrice: prev,
        trend,
        tracked_at: info.latest.scraped_at,
      });
    });

    return arr.sort(
      (a, b) => new Date(b.tracked_at) - new Date(a.tracked_at)
    ).slice(0, 6);
  }, [products, latestByProduct]);

  const featuredHistory = useMemo(() => {
    if (!featuredProductId) return [];

    const info = latestByProduct[featuredProductId];
    if (!info) return [];

    return info.all.slice(-30).map((r) => {
      const dt = r.scraped_at
        ? (String(r.scraped_at).includes('T') ? new Date(r.scraped_at) : new Date(`${r.scraped_at}T00:00:00Z`))
        : null;
      return {
        // en-GB forces DD/MM/YYYY
        date: dt ? dt.toLocaleDateString('en-GB') : '',
        price: Number(r.price) || 0,
        _ts: dt ? dt.getTime() : 0, // optional: helps sorting if needed
      };
    });
  }, [featuredProductId, latestByProduct]);

  const featuredProduct = products.find(
    (p) => p.product_id === featuredProductId
  );

  const placeholderImage = "/mnt/data/Screenshot 2025-11-23 223800.png";

  // ------------ UI --------------

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
          <StatCard label="Tracked Products" value={trackedCount} color="blue" />
          <StatCard label="Price Drops (24h)" value={priceDropsLast24h} color="green" />
          <StatCard label="Avg. Saving" value={`${avgSavingPct}%`} color="gray" />
        </div>

        {/* Two-Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent Price Changes */}
          <RecentChanges recentChanges={recentChanges} placeholderImage={placeholderImage} loading={loading} error={error} />

          {/* Featured Trend */}
          <FeaturedTrend featuredProduct={featuredProduct} featuredHistory={featuredHistory} loading={loading} />
        </div>
      </div>
    </div>
  );
}

/* ----- Helper Components (Same UI, cleaner code) ----- */

function StatCard({ label, value, color }) {
  return (
    <div className="bg-white p-6 rounded-lg shadow-sm flex justify-between items-center">
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-2xl font-semibold text-gray-900">{value}</p>
      </div>
    </div>
  );
}

function RecentChanges({ recentChanges, placeholderImage, loading, error }) {
  if (loading)
    return <div className="space-y-4"><Skeleton /><Skeleton /><Skeleton /></div>;

  if (error) return <p className="text-red-600">{error}</p>;

  if (recentChanges.length === 0)
    return <p className="text-sm text-gray-600">No tracked products yet.</p>;

  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-4">Recent Price Changes</h3>

      <div className="space-y-3">
        {recentChanges.map((item) => (
          <div key={item.product.product_id} className="flex justify-between p-3 border rounded">
            <div className="flex items-center space-x-3">
              <img
                src={item.product.image_url || placeholderImage}
                className="h-12 w-12 rounded object-cover"
              />
              <div>
                <div className="font-semibold">{item.product.title}</div>
                <div className="text-xs text-gray-500">
                  {new URL(item.product.url).hostname.replace("www.", "")}
                </div>
              </div>
            </div>

            <div className="text-right">
              <div className={`text-sm font-semibold ${
                item.trend === "down" ? "text-green-600" :
                item.trend === "up" ? "text-red-600" :
                "text-gray-900"
              }`}>
                ₹{item.latestPrice.toLocaleString()}
                {item.trend === "down" ? " ↓" : item.trend === "up" ? " ↑" : ""}
              </div>
              {item.prevPrice !== null && (
                <div className="text-xs line-through text-gray-400">
                  ₹{item.prevPrice.toLocaleString()}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FeaturedTrend({ featuredProduct, featuredHistory, loading }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6 flex flex-col">
      <h3 className="text-lg font-medium text-gray-900">Featured Trend</h3>
      <p className="text-sm text-gray-500">{featuredProduct?.title || "—"}</p>

      <div className="mt-4 flex-1 min-h-[220px]">
        {loading ? (
          <div className="h-56 bg-gray-100 rounded" />
        ) : featuredHistory.length === 0 ? (
          <div className="h-56 flex items-center justify-center text-gray-500">No history</div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={featuredHistory}>
              <defs>
                <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="date" />
              <YAxis tickFormatter={(v) => `₹${v}`} />
              <Tooltip formatter={(v) => `₹${v.toLocaleString()}`} />
              <Area type="monotone" dataKey="price" stroke="#0284c7" fill="url(#colorPrice)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function Skeleton() {
  return <div className="h-16 bg-gray-100 rounded animate-pulse" />;
}
