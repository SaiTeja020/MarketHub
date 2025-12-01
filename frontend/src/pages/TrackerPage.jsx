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

      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData?.user) {
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

        const productRows = prodResp.data.products || [];
        setProducts(productRows);

        const ids = productRows.map((p) => p.product_id);

        // 2) Fetch price history from dashboard endpoint (lighter than ES queries)
        const histResp = await api.get("/dashboard", {
          params: { user_id: userId },
        });

        setPriceHistory(histResp.data.price_history || []);
      } catch (err) {
        console.error(err);
        if (mounted) setError(err.message || "Failed to load tracker data");
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
      if (!map[r.product_id]) map[r.product_id] = [];
      map[r.product_id].push(r);
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
        url,
        image_url: null,
        current_price: null,
        source: safeHost(url),
      });

      alert("Product added! Scraper will update it soon.");
      window.location.reload();
    } catch (err) {
      console.error(err);
      alert(err.message || "Failed to add product.");
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
      console.error(err);
      alert(err.message || "Failed to delete product.");
    }
  }

  function formatCurrency(v) {
    if (v === null || v === undefined) return "—";
    const n = Number(v);
    if (Number.isNaN(n)) return "—";
    return `₹${n.toLocaleString()}`;
  }

  function SmallSparkline({ points }) {
    if (!points || points.length < 2) {
      return <div className="text-xs text-gray-400">No data</div>;
    }

    const data = points.slice(-12).map((r) => ({
      date: new Date(r.scraped_at).toLocaleDateString(),
      price: Number(r.price) || 0,
    }));

    return (
      <div className="h-16">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#34d399" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} horizontal={false} />
            <XAxis hide dataKey="date" />
            <YAxis hide />
            <Tooltip formatter={(v) => formatCurrency(v)} />
            <Area
              type="monotone"
              dataKey="price"
              stroke="#10b981"
              fill="url(#g1)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="max-w-7xl mx-auto">
        {/* Header + Add Button */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">My Tracker</h1>
            <p className="text-sm text-gray-500">
              Monitor price changes in real-time.
            </p>
          </div>

          <button
            onClick={handleAddProduct}
            disabled={adding}
            className="bg-sky-600 text-white px-4 py-2 rounded shadow hover:bg-sky-700"
          >
            + Add Product
          </button>
        </div>

        {/* Products */}
        {loading ? (
          <div>Loading…</div>
        ) : error ? (
          <div className="text-red-600">{error}</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleProducts.map((p) => {
              const hist = historyByProduct[p.product_id] || [];
              const latest =
                p.current_price ??
                (hist.length ? hist[hist.length - 1].price : null);

              return (
                <article
                  key={p.product_id}
                  className="bg-white rounded-lg shadow-sm p-4"
                >
                  <h3 className="text-lg font-semibold">{p.title}</h3>
                  <p className="text-gray-500">{safeHost(p.url)}</p>

                  <div className="mt-2 text-xl font-bold">
                    {formatCurrency(latest)}
                  </div>

                  <div className="mt-4">
                    <SmallSparkline points={hist} />
                  </div>

                  <div className="flex justify-between mt-4">
                    <button
                      onClick={() => navigate(`/product/${p.product_id}`)}
                      className="px-3 py-1 border rounded"
                    >
                      Details
                    </button>

                    <button
                      onClick={() => handleRemoveProduct(p.product_id)}
                      className="px-3 py-1 text-red-600"
                    >
                      Remove
                    </button>
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
