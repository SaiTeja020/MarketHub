import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase.js";
import { useNavigate } from "react-router-dom";
import { LineChart, Line, XAcis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

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
  const historyByProduct = useMemo(() =>{})
}
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


