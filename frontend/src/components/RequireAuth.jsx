import {  Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function requireAuth({children}){
    const [loading, setLoading] = useState(true);
    const [authenticated, setAuthenticated] = useState(false);

    useEffect(() =>{
        const checkUser = async () =>{
            const {data : {user}} = await supabase.auth.getUser();

            if(user){
                setAuthenticated(true);
            }
            else{
                setAuthenticated(false);
            }
            setLoading(false);
        };
        checkUser();
    }, []);

    if(loading)return null;

    return authenticated ? children : <Navigate to="/login" />;
}