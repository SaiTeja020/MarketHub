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
  ResponsiveContainer
} from "recharts";

function safeHost(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "";
  }
}

export default function ProductPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [product, setProduct] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [retailerPrices, setRetailerPrices] = useState([]);
  const [error, setError] = useState("");

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
        setError(err.message || "Failed to load product");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [id]);

  const chartData = useMemo(() => {
    return priceHistory.map((p) => ({
      date: new Date(p.scraped_at).toLocaleDateString(),
      price: Number(p.price) || 0,
    }));
  }, [priceHistory]);

  function formatCurrency(v) {
    if (v === null || v === undefined) return "-";
    const n = Number(v);
    if (isNaN(n)) return "-";
    return `₹${n.toLocaleString()}`;
  }

  if (!loading && !product) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-xl font-semibold">Product Not Found</h1>
        <button
          onClick={() => navigate(-1)}
          className="px-4 py-2 bg-sky-600 text-white rounded mt-4"
        >
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
          <div className="bg-white rounded-lg shadow p-6 flex gap-6">
            <div className="w-48 h-48 bg-gray-100 rounded flex items-center justify-center overflow-hidden">
              {product.image_url ? (
                <img src={product.image_url} className="object-cover w-full h-full" />
              ) : (
                <span>No Image</span>
              )}
            </div>

            <div className="flex-1">
              <h1 className="text-2xl font-bold">{product.title}</h1>
              <p className="text-gray-500">{safeHost(product.url)}</p>

              <div className="mt-4">
                <div className="text-sm text-gray-500">Current Price</div>
                <div className="text-3xl font-bold text-sky-700">
                  {formatCurrency(product.current_price)}
                </div>

                <div className="grid grid-cols-3 gap-4 mt-4">
                  <div>
                    <div className="text-xs text-gray-500">Lowest</div>
                    <div>{formatCurrency(product.lowest_price)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Highest</div>
                    <div>{formatCurrency(product.highest_price)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Tracking Since</div>
                    <div>{new Date(product.scraped_at).toLocaleDateString()}</div>
                  </div>
                </div>
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
                    <YAxis />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey="price"
                      stroke="#0ea5e9"
                      fill="url(#g2)"
                      strokeWidth={2}
                    />
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
                <div key={r.id} className="flex justify-between p-3 bg-gray-50 rounded mb-2">
                  <span>{r.retailer_name}</span>
                  <span>{formatCurrency(r.price)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
