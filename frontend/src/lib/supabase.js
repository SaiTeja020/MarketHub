
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if(!supabaseUrl || !supabaseAnonKey){
    throw new Error("Missing Supabase environment variables");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        storage: sessionStorage,       // ⬅️ only keep session per tab
        autoRefreshToken: true,        // ⬅️ allow refresh while tab is open
        persistSession: true           // ⬅️ persist only within the session (tab)
    }
});
