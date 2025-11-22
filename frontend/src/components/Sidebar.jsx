import { Link, useLocation } from "react-router-dom";
import { useUserStore } from "../store/useUserStore.js";

export default function Sidebar(){
    const logout = useUserStore((s) => s.logout);
    const location = useLocation();

    const navItems = [
        {name : 'Dashboard', path: '/' },
        {name : "My Tracker", path: '/tracker'},
        {name : "Analytics", path: '/analytics'}
    ];

    return(
        <aside className = "w-64 bg-white shadow-md p-6 flex-col border-r">
            <h1 className = "text2x1 font-bold mb-10">MarketHub</h1>
            <nav className = "flex flex-col gap-4 flex-1">
                {navItems.map((item) =>(
                    <Link
                        key = {item.path}
                        to = {item.path}
                        className = {`text-gray-700 hover:text-blue-600 ${
                            location.pathname === item.path ? "font-bold text-blue-500" : ""
                        }`}
                    >
                        {item.name}
                    </Link>
                ))}
            </nav>

            <button onClick={logout} className = "mt-auto text-gray-500 hover:text-red-500">
                Logout
            </button>
        </aside>
    );
}