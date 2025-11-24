import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase.js";
import { useNavigate } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Area, AreaChart } from "recharts";

/**
 * MyTracker.jsx
 *
 * Assumes tables:
 *  - products (id, user_id, title, url, image_url, current_price, lowest_price, highest_price, store, is_active, created_at)
 *  - price_history (id, product_id, price, tracked_at)
 *
 * This component:
 *  - loads products for current user
 *  - loads recent price_history for those products (last 30 entries each)
 *  - shows grid cards with price, percent saved, updated label
 *  - supports search, details navigation and remove (delete) action
 *
 * Placeholder image (uploaded): /mnt/data/8c385096-2f52-4bef-bb65-ad4ebb2ed7f2.png
 */

export default function TrackerPage() {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [priceHistories, setPriceHistories] = useState({});
  const [searchTerm, setSearchTerm] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData?.user) {
        setError("Failed to load user.");
        setLoading(false);
        return;
      }

      const userId = userData.user.id;

      try {
        const { data: productRows, error: prodErr } = await supabase
          .from("products")
          .select("id, title, url, image_url, current_price, lowest_price, highest_price, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (prodErr) {
          throw prodErr;
        }

        const ids = (productRows || []).map((p) => p.id);
        let phRows = [];

        if (ids.length) {
          const { data: phData, error: phErr } = await supabase.
            from("price_history")
            .select("id, product_id, price, tracked_at")
            .in("product_id", ids)
            .order("tracked_at", { ascending: true });

          if (phErr) {
            throw phErr;
          }

          phRows = phData || [];
        }

        if (!mounted) return;
        setProducts(productRows || []);
        setPriceHistories(phRows);

      }
      catch (err) {
        console.error(err);
        setError(err.message || "Failed to load tracker data");
      }
      finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, []);

  // Map price history by product id for quick lookup
  const historyByProduct = useMemo(() => {
    const map = {};
    for (const r of priceHistories) {
      if (!map[r.product_id]) map[r.product_id] = [];
      map[r.product_id].push(r);
    }
    return map;
  }, [priceHistories]);

  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;

    return products.filter((p) =>
      (p.title.toLowerCase().includes(q)) ||
      (p.store_name || "").toLowerCase().includes(q)
        (p.url || "").toLowerCase().includes(q)
    );
  }, [, search]);

  // Add product — simple prompt flow (replace with modal if you want)
  async function handleAddProduct() {
    const url = prompt("Paste product URL to track:");
    if (!url) return;

    const title = window.prompt("Enter a title for this product (or leave Blank):", "");
    setAdding(true);
    try {
      const { data, error: insertErr } = await supabase.from("products").insert([
        {
          user_id: (await supabase.auth.getUser()).data.user.id,
          title: title || "New Product",
          url,
          image_url: "",
          current_price: null,
          lowest_price: null,
          highest_price: null,
          is_active: true
        },
      ]);
      if (insertErr) {
        throw insertErr;
      }

      //Refresh locally: insert at front
      setProducts((prev) => [data[0], ...prev]);
      // Ideally your scraper or worker will pick up this product and populate prices
      alert("Product added. Your scraper will fetch prices shortly.");
    }
    catch (err) {
      console.error(err);
      alert(err.message || "Failed to add product.");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveProduct(id) {
    const ok = window.confirm("Remove this tracked product? This will delete its history.");
    if (!ok) return;
    try {
      const { error: delErr } = await supabase.from("products").delete().eq("id", id);
      if (delErr) {
        throw delErr;
      }
      // Also price_history should cascade if DB set up; otherwise remove explicitly:
      await supabase.from("price_history").delete().eq("product_id", id);
      setProducts((prev) => prev.filter((p) => p.id !== id));
    }
    catch (err) {
      console.error(err);
      alert(err.message || "Failed to remove product.");
    }
  }

  function formatCurrency(v) {
    if (v === null || v === undefined) return "-";
    const n = Number(v);
    if (Number.isNaN(n)) return "-";
    return `₹${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }

  function sparkLine({ points }) {
    if (!points || points.length < 2) {
      return (
        <div className="text-xs text-gray-400">No data</div>
      );
    }

    const data = points.slice(Math.max(points.length - 12, 0)).map((r) => ({
      date: new Date(r.tracked_at).toLocaleDateString(),
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
            <XAxis dataKey="date" hide />
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Tooltip formatter={(v) => formatCurrency(v)} />
            <Area type="monotone" dataKey="price" stroke="#10b981" fill="url(#g1)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }
  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      <div className="max-w-7xl mx-auto">
        {/* Header + Add */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">My Tracker</h1>
            <p className="text-sm text-gray-500">Monitor prices across different stores in real-time.</p>
          </div>

          <div className="flex items-center space-x-3">
            <div className="w-[420px]">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tracked products..."
                className="w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm focus:ring-2 focus:ring-sky-200 focus:border-sky-300"
              />
            </div>

            <button
              onClick={handleAddProduct}
              disabled={adding}
              className="inline-flex items-center gap-2 bg-sky-600 hover:bg-sky-700 text-white px-4 py-2 rounded shadow"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add Product
            </button>
          </div>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-64 bg-white rounded-lg shadow-sm animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <div className="text-red-600">{error}</div>
        ) : visibleProducts.length === 0 ? (
          <div className="bg-white rounded-lg p-8 text-gray-600">No tracked products yet.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleProducts.map((p) => {
              const hist = historyByProduct[p.id] || [];
              // latest price: prefer p.current_price, otherwise last history point
              const latestPrice = p.current_price ?? (hist.length ? Number(hist[hist.length - 1].price) : null);
              const highest = Number(p.highest_price) || 0;
              const savePct = highest > 0 && latestPrice !== null ? Math.round(((highest - latestPrice) / highest) * 100) : 0;
              const trend = hist.length >= 2 ? (Number(hist[hist.length - 1].price) < Number(hist[hist.length - 2].price) ? "down" : "up") : "neutral";

              return (
                <article key={p.id} className="bg-white rounded-lg shadow-sm overflow-hidden">
                  <div className="bg-slate-50 p-6 flex items-center justify-center relative">
                    <img
                      src={p.image_url || PLACEHOLDER_IMAGE}
                      alt={p.title}
                      className="h-40 w-40 object-cover rounded-md"
                    />
                    <span className="absolute top-4 right-4 inline-flex items-center px-2 py-1 bg-emerald-50 text-emerald-700 text-xs font-medium rounded">Active</span>
                  </div>

                  <div className="p-4">
                    <h3 className="text-lg font-semibold text-gray-900 mb-1">{p.title}</h3>
                    <div className="text-sm text-gray-500 mb-4">{p.store_name || new URL(p.url || "https://example.com").hostname.replace("www.", "")}</div>

                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs text-gray-500">CURRENT PRICE</div>
                        <div className={`text-2xl font-bold ${trend === "down" ? "text-green-600" : trend === "up" ? "text-red-600" : "text-gray-900"}`}>
                          {formatCurrency(latestPrice)}
                        </div>
                      </div>

                      <div className="text-sm">
                        <div className="inline-flex items-center px-2 py-1 bg-emerald-50 text-emerald-700 text-xs font-medium rounded">
                          Save {savePct}%
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 border-t pt-4 flex items-center justify-between text-sm text-gray-500">
                      <div className="flex items-center space-x-3">
                        <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3" />
                        </svg>
                        <span>Updated recently</span>
                      </div>

                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => navigate(`/product/${p.id}`)}
                          className="px-3 py-1 border rounded text-sm text-gray-700 hover:bg-gray-50"
                        >
                          Details
                        </button>

                        <button
                          onClick={() => handleRemoveProduct(p.id)}
                          title="Remove tracking"
                          className="px-2 py-1 rounded text-sm text-gray-400 hover:text-red-600"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7v10a2 2 0 002 2h2a2 2 0 002-2V7M10 7V5a2 2 0 012-2h0a2 2 0 012 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* sparkline */}
                    <div className="mt-4">
                      <SmallSparkline points={hist} />
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