import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase.js";
import { useParams } from "react-router-dom";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

export default function AnalyticsPage() {
  const { id } = useParams(); // product id from route

  const [loading, setLoading] = useState(true);
  const [product, setProduct] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [retailerPrices, setRetailerPrices] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) {
      setError("Invalid product ID");
      setLoading(false);
      return;
    }

    let mounted = true;

    async function loadAll() {
      try {
        setLoading(true);
        setError("");

        /** 1) Fetch product */
        const { data: prodData, error: prodErr } = await supabase
          .from("products")
          .select(
            "id, title, url, image_url, current_price, lowest_price, highest_price, created_at"
          )
          .eq("id", id)
          .single();

        if (prodErr && prodErr.code !== "PGRST116") throw prodErr;

        if (!mounted) return;
        setProduct(prodData || null);

        /** 2) Fetch price history */
        const { data: phData, error: phErr } = await supabase
          .from("price_history")
          .select("id, product_id, price, tracked_at")
          .eq("product_id", id)
          .order("tracked_at", { ascending: true });

        if (phErr) throw phErr;
        if (!mounted) return;
        setPriceHistory(phData ?? []);

        /** 3) Fetch retailer comparison */
        const { data: rpData, error: rpErr } = await supabase
          .from("retailer_prices")
          .select("id, product_id, retailer_name, price, recorded_at")
          .eq("product_id", id)
          .order("recorded_at", { ascending: false });

        if (rpErr) throw rpErr;
        if (!mounted) return;
        setRetailerPrices(rpData ?? []);
      } catch (err) {
        console.error(err);
        if (mounted) {
          setError(err.message || "Failed to load analytics data");
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadAll();

    return () => {
      mounted = false;
    };
  }, [id]);

  // ---- Derived Chart Data ----
  const chartData = useMemo(() => {
    if (!priceHistory.length) return [];
    return priceHistory.map((p) => ({
      date: new Date(p.tracked_at).toLocaleDateString(),
      price: Number(p.price) || 0,
    }));
  }, [priceHistory]);

  // ---- UI render safety ----
  if (!id) {
    return (
      <div className="p-8 bg-gray-50 min-h-screen">
        <div className="text-red-600">Invalid product ID.</div>
      </div>
    );
  }

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
      <h1 className="text-2xl font-bold text-gray-900 mb-4">
        Analytics — {product.title}
      </h1>

      {/* Chart */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 text-gray-800">
          Price Trend
        </h2>

        {chartData.length === 0 ? (
          <div className="text-gray-500 text-sm">No price history available.</div>
        ) : (
          <div className="w-full h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>

                <CartesianGrid strokeDasharray="3 3" />

                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />

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
      </div>

      {/* Retailer comparison */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-lg font-semibold mb-3 text-gray-800">
          Retailer Comparison
        </h2>

        {retailerPrices.length === 0 ? (
          <div className="text-gray-500 text-sm">No retailer data available.</div>
        ) : (
          <ul className="space-y-2">
            {retailerPrices.slice(0, 5).map((r) => (
              <li
                key={r.id}
                className="flex justify-between border-b py-2 text-gray-700"
              >
                <span>{r.retailer_name}</span>
                <span className="font-semibold">₹{r.price}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
