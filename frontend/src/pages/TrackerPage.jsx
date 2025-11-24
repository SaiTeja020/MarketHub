import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase.js";
import { useNavigate } from "react-router-dom";
import { LineChart, Line, XAcis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Area, AreaChart } from "recharts";

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

          if(prodErr){
            throw prodErr;
          }

          const ids = (productRows || []).map((p) => p.id);
          let phRows = [];

          if(ids.length){
            const {data: phData, error: phErr} = await supabase.
            from("price_history")
            .select("id, product_id, price, tracked_at")
            .in("product_id", ids)
            .order("tracked_at", {ascending: true});
            
            if(phErr){
              throw phErr;
            }

            phRows = phData || [];
          }

          if(!mounted) return;
          setProducts(productRows || []);
          setPriceHistories(phRows);

      }
      catch (err) {
        console.error(err);
        setError(err.message || "Failed to load tracker data");
      }
      finally{
        if(mounted) setLoading(false);
      }
    }

    load();

    return() =>{
      mounted = false;
    };
  }, []);

  // Map price history by product id for quick lookup
  const historyByProduct = useMemo(() =>{
    const map = {};
    for(const r of priceHistories){
      if(!map[r.product_id]) map[r.product_id] = [];
      map[r.product_id].push(r);
    }
    return map;
  }, [priceHistories]);

  const visibleProducts = useMemo(() =>{
    const q = search.trim().toLowerCase();
    if(!q) return products;

    return products.filter((p) => 
      (p.title.toLowerCase().includes(q)) ||
      (p.store_name|| "").toLowerCase().includes(q)
      (p.url || "").toLowerCase().includes(q)
    );
  }, [, search]);

  // Add product — simple prompt flow (replace with modal if you want)
  async function handleAddProduct(){
    const url = prompt("Paste product URL to track:");
    if(!url) return;

    const title = window.prompt("Enter a title for this product (or leave Blank):", "");
    setAdding(true);
    try{
      const {data, error: insertErr } = await supabase.from("products").insert([
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
      if(insertErr){
        throw insertErr;
      }

      //Refresh locally: insert at front
      setProducts((prev) => [data[0], ...prev]);
      // Ideally your scraper or worker will pick up this product and populate prices
      alert("Product added. Your scraper will fetch prices shortly.");
    }
    catch(err){
      console.error(err);
      alert(err.message || "Failed to add product.");
    }finally{
      setAdding(false);
    }
  }

  async function handleRemoveProduct(id){
    const ok = window.confirm("Remove this tracked product? This will delete its history.");
    if(!ok) return;
    try{
      const {error: delErr } = await supabase.from("products").delete().eq("id", id);
      if(delErr){
        throw delErr;
      }
      // Also price_history should cascade if DB set up; otherwise remove explicitly:
      await supabase.from("price_history").delete().eq("product_id", id);
      setProducts((prev) => prev.filter((p) => p.id !== id));
    }
    catch(err){
      console.error(err);
      alert(err.message || "Failed to remove product.");
    }
  }

  function formatCurrency(v){
    if(v === null || v === undefined) return "-";
    const n = Number(v);
    if(Number.isNaN(n)) return "-";
    return `₹${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
}