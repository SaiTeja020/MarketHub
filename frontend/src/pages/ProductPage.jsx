import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase.js";
import {
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Area,
  AreaChart,
  ResponsiveContainer
} from "recharts";

/**
 * ProductPage.jsx
 *
 * Expects Supabase tables:
 *  - products (id, user_id, title, url, image_url, store_name, current_price, lowest_price, highest_price, created_at)
 *  - price_history (id, product_id, price, tracked_at)
 *
 * Placeholder image: use uploaded design located at:
 * /mnt/data/75a6027f-3644-4613-9a3d-dd4cca600172.png
 *
 * Notes:
 *  - This is a UI-first implementation; "Analyze Deal" and "Refresh" toggles are placeholders that call stub functions.
 *  - Ensure RLS permits the user to read their own products (auth.uid() = user_id).
 */

function safeHost(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "";
  }
}

export default function ProductPage(){
  const { id } = useParams(); // product id from route
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [product, setProduct] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [retailerPrices, setRetailerPrices] = useState([]);
  const [error, setError] = useState("");

  useEffect(() =>{
    let mounted = true;
    async function load(){
      setLoading(true);
      setError("");

      try{
        /** 1) Fetch product */
        const { data: prodData, error: prodError} = await supabase
          .from("products")
          .select("id, title, url, image_url, store_name, current_price, lowest_price, highest_price, created_at")
          .eq("id", id)
          .single();

          // PGRST116 = no rows found -> valid "not found" case
          if(prodError && prodError.code !== "PGRST116") throw prodError;

          const p = prodData || null;

          // 2) Fetch price history
          const { data: phData, error: phErr } = await supabase
          .from("price_history")
          .select("id, product_id, price, tracked_at")
          .eq("product_id", id)
          .order("tracked_at", { ascending: true });

        if(phErr) throw phErr;

        // 3) Fetch retailer comparison
        const { data: rpData, error: rpErr } = await supabase
          .from("retailer_prices")
          .select("id, product_id, retailer_name, price, recorded_at")
          .eq("product_id", id)
          .order("recorded_at", { ascending: false });

          if(rpErr && rpErr.code !== "PGRST116"){
             throw rpErr;
          }
          if(!mounted) return;
          
          setProduct(p);
          setPriceHistory(phData ?? []);
          setRetailerPrices(rpData ?? []);
        }
        catch(err){
          console.error(err);
          setError(err.message || "Failed to load product");
        } finally{
          if(mounted) setLoading(false);
        }
    }
    load();
    return () =>{
      mounted = false;
    }
  }, [id]);

  // Defensive: product not found
  if(!loading && !product){
    return (
      <div className="p-10 text-center text-gray-600">
        <h1 className="text-xl font-semibold mb-3">Product Not Found</h1>
        <button
          onClick={() => navigate(-1)}
          className="px-4 py-2 rounded bg-sky-600 text-white hover:bg-sky-700"
        >
          Go Back
        </button>
      </div>
    );
  }

  function formatCurrency(v){
    if(v === null || v === undefined) return "-";
    const n = Number(v);
    if(isNaN(n)) return "-";
    return `₹${n.toLocaleString()}`;
  }

  // Use last 30 points for chart
  const chartData = useMemo(() =>{
    if(!priceHistory || priceHistory.length === 0) return [];
    return priceHistory.map((p) =>({
      date: new Date(p.tracked_at).toLocaleDateString(),
      price: Number(p.price) || 0,
    }));
  }, [priceHistory]);

  return (
    <div className="p-8 bg-gray-50 min-h-screen">
      {loading ? (
        <div className="text-gray-600">Loading…</div>
      ) : error ? (
        <div className="text-red-600">{error}</div>
      ) : (
        <div className="max-w-5xl mx-auto space-y-8">

          {/* Top Section */}
          <div className="bg-white rounded-lg shadow p-6 flex gap-6">
            {/* Image */}
            <div className="w-48 h-48 bg-gray-100 rounded flex items-center justify-center overflow-hidden">
              {product.image_url ? (
                <img
                  src={product.image_url}
                  alt={product.title}
                  className="object-cover w-full h-full"
                  onError={(e) => (e.currentTarget.style.display = "none")}
                />
              ) : (
                <span className="text-gray-400 text-sm">No Image</span>
              )}
            </div>

            {/* Info */}
            <div className="flex-1">
              <h1 className="text-2xl font-bold text-gray-900 mb-2">
                {product.title}
              </h1>
              <p className="text-gray-500">
                {product.url ? safeHost(product.url) : ""}
              </p>

              <div className="mt-4 space-y-1">
                <div className="text-sm text-gray-500">Current Price</div>
                <div className="text-3xl font-bold text-sky-700">
                  {formatCurrency(product.current_price)}
                </div>

                <div className="grid grid-cols-3 gap-4 mt-4">
                  <div className="bg-gray-50 p-3 rounded">
                    <div className="text-xs text-gray-500">Lowest</div>
                    <div className="font-semibold">{formatCurrency(product.lowest_price)}</div>
                  </div>
                  <div className="bg-gray-50 p-3 rounded">
                    <div className="text-xs text-gray-500">Highest</div>
                    <div className="font-semibold">{formatCurrency(product.highest_price)}</div>
                  </div>
                  <div className="bg-gray-50 p-3 rounded">
                    <div className="text-xs text-gray-500">Tracking Since</div>
                    <div className="font-semibold">
                      {new Date(product.created_at).toLocaleDateString("en-IN")}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Price Trend Chart */}
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-lg font-semibold mb-4">Price Trend</h2>

            {chartData.length === 0 ? (
              <div className="text-gray-500 text-sm">No price data available.</div>
            ) : (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey="price"
                      stroke="#0ea5e9"
                      fill="url(#priceGradient)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Retailer Comparison */}
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-lg font-semibold mb-4">Retailer Comparison</h2>

            {retailerPrices.length === 0 ? (
              <div className="text-gray-500 text-sm">No retailer data available.</div>
            ) : (
              <div className="space-y-2">
                {retailerPrices.map((r) => (
                  <div
                    key={r.id}
                    className="flex justify-between bg-gray-50 p-3 rounded"
                  >
                    <span className="font-medium">{r.retailer_name}</span>
                    <span>{formatCurrency(r.price)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}