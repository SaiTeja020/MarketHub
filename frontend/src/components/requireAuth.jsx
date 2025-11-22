import {  Navigate } from "react-router-dom";
import { useUserStore } from "../store/useUserStore.js";

export default function requireAuth({children, allowedRoles}){
    const role = useUserStore((s) => s.role);

    if(!role) return <Navigate to="/login" replace />;

    if(allowedRoles && !allowedRoles.includes(role)){
        return <div>Access Denied</div>;
    }

    return children;
}