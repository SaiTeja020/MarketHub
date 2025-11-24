import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabase.js";
import { useNavigate } from "reaact-router-dom";
import { LineChart, Line, Xaxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from  "recharts";

/**
 * AnalyticsPage.jsx
 *
 * - Connected version (B): reads product, price_history and retailer_prices from Supabase
 * - Expects tables:
 *    products(id, user_id, title, url, image_url, current_price, lowest_price, highest_price, created_at)
 *    price_history(id, product_id, price, tracked_at)  -- datetime in tracked_at
 *    retailer_prices(id, product_id, retailer_name, price, recorded_at)
 *
 * - Uses uploaded placeholder image when product.image_url is missing:
 *    /mnt/data/b879e423-63d2-452c-945b-411782016389.png
 *
 * - Safe guards: always treats results as arrays (data ?? [])
 */

export default function AnalyticsPage(){
  const { id } = useParams(); //productid from route
  const [loading, setLoading] = useState(true);
  const [product, setProduct] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [retailerPrices, setRetailerPrices] = useState([]);
  const [error, setError ] = useState("");

  useEffect(() =>{
    let mounted = true;
    async function load(){
      setLoading(true);
      const { data: prodData, error: prodErr } = await supabase
        .from("products")
        .select("id, title, url, image_url, current_price, lowest_price, highest_price, created_at")
        .eq("id", id)
        .single();
        if(prodErr && prodErr.code!=="PGRST116"){
          throw prodErr;
        }
        const productRows=prodData||null;
        // 2) fetch price history for product (ascending by tracked_at)
        const {data:phData,error:phErr}=await supabase
        .from("price_history")
        .select("id,product_id,price,tracked_at")
        .eq("product_id",id)
        .order("tracked_at",{ascending: true})
        if(phErr) throw phErr;

        // 3) fetch retailer comparison (most recent per retailer)
        // We'll select rows ordered by recorded_at desc and let client pick top latest per retailer.
        
    }
  })
}