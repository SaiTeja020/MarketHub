import {  Navigate } from "react-router-dom";
import { useUserStore } from "../store/useUserStore.js";

export default function requireAuth({children}){
    const jwt = useUserStore((s) => s.jwt);

    if(!jwt) return <Navigate to="/login" replace />;

    return children;
}