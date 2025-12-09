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
  Legend,
  AreaChart,
  Area,
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

  // ----- NEW: Build multi-product chart series -----
  const productSeries = useMemo(() => {
    // collect product ids we want to plot (use all tracked products)
    const productList = products.map((p) => ({
      product_id: p.product_id,
      title: p.title,
    }));

    // helper to build date string (en-GB as before)
    function formatDate(scraped_at) {
      if (!scraped_at) return "";
      const dt = String(scraped_at).includes("T")
        ? new Date(scraped_at)
        : new Date(`${scraped_at}T00:00:00Z`);
      return dt.toLocaleDateString("en-GB");
    }

    // collect all dates across products into a Set
    const dateSet = new Set();
    productList.forEach(({ product_id }) => {
      const arr = latestByProduct[product_id]?.all || [];
      arr.forEach((r) => {
        dateSet.add(formatDate(r.scraped_at));
      });
    });

    // create sorted dates array by timestamp (so chart x-axis flows correctly)
    const dateArray = Array.from(dateSet).filter(Boolean);
    // To sort reliably we map to timestamps using any available scraped_at for that date.
    // Build a map date->timestamp (pick first match)
    const dateToTs = {};
    priceHistory.forEach((r) => {
      const d = formatDate(r.scraped_at);
      if (!d) return;
      const ts = (String(r.scraped_at).includes("T") ? new Date(r.scraped_at) : new Date(`${r.scraped_at}T00:00:00Z`)).getTime();
      if (!dateToTs[d] || dateToTs[d] > ts) dateToTs[d] = ts;
    });
    dateArray.sort((a, b) => (dateToTs[a] || 0) - (dateToTs[b] || 0));

    // Build a map for quick lookup of price by product_id+date
    const priceMap = {}; // key: `${product_id}||${date}` -> price
    priceHistory.forEach((r) => {
      const pid = r.product_id;
      const d = formatDate(r.scraped_at);
      priceMap[`${pid}||${d}`] = Number(r.price) || 0;
    });

    // Build chart rows: { date: 'DD/MM/YYYY', '<pid1>': price, '<pid2>': price, ... }
    const chartData = dateArray.map((d) => {
      const row = { date: d };
      productList.forEach(({ product_id }) => {
        const key = `${product_id}||${d}`;
        row[product_id] = priceMap.hasOwnProperty(key) ? priceMap[key] : null;
      });
      return row;
    });

    return { productList, chartData };
  }, [products, latestByProduct, priceHistory]);

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
        </div>

        {/* Two-Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent Price Changes */}
          <RecentChanges recentChanges={recentChanges} placeholderImage={placeholderImage} loading={loading} error={error} />

          {/* Featured Trend - now multi-line */}
          <FeaturedTrend
            featuredProduct={featuredProduct}
            featuredHistory={productSeries.chartData}
            productList={productSeries.productList}
            loading={loading}
          />
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
      <h3 className="text-lg font-medium text-gray-900 mb-4">Current Prices</h3>

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

function FeaturedTrend({ featuredProduct, featuredHistory, productList, loading }) {
  // color palette (wraps if productList > palette length)
  const palette = [
    "#0284c7", // blue
    "#ef4444", // red
    "#10b981", // green
    "#f59e0b", // amber
    "#8b5cf6", // violet
    "#ec4899", // pink
    "#06b6d4", // cyan
    "#94a3b8", // slate
  ];

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-6 flex flex-col">
        <h3 className="text-lg font-medium text-gray-900">Product Trend</h3>
        <p className="text-sm text-gray-500">{featuredProduct?.title || "—"}</p>
        <div className="mt-4 flex-1 min-h-[220px]">
          <div className="h-56 bg-gray-100 rounded" />
        </div>
      </div>
    );
  }

  if (!featuredHistory || featuredHistory.length === 0 || !productList || productList.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-6 flex flex-col">
        <h3 className="text-lg font-medium text-gray-900">Product Trend</h3>
        <p className="text-sm text-gray-500">{featuredProduct?.title || "—"}</p>
        <div className="mt-4 flex-1 min-h-[220px] flex items-center justify-center text-gray-500">No history</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-6 flex flex-col">
      <h3 className="text-lg font-medium text-gray-900">Products Trend</h3>
      <p className="text-sm text-gray-500">Multi-product view</p>

      <div className="mt-4 flex-1 min-h-[220px]">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={featuredHistory}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="date" />
            <YAxis tickFormatter={(v) => `₹${v}`} />
            <Tooltip
              formatter={(value, name) => {
                // name is product_id; try to show title instead
                const prod = productList.find((p) => p.product_id === name);
                const label = prod ? prod.title : name;
                return [`₹${(value || 0).toLocaleString()}`, label];
              }}
            />
            <Legend
              formatter={(value) => {
                const prod = productList.find((p) => p.product_id === value);
                return prod ? prod.title : value;
              }}
            />
            {productList.map((p, idx) => (
              <Line
                key={p.product_id}
                type="monotone"
                dataKey={p.product_id}
                name={p.product_id} // used by tooltip/legend; formatter maps to title
                stroke={palette[idx % palette.length]}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Skeleton() {
  return <div className="h-16 bg-gray-100 rounded animate-pulse" />;
}
