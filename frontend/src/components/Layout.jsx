import { NavLink, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function Layout({ children }) {
  const navigate = useNavigate();

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate("/login");
  }

  return (
    <div className="flex h-screen bg-gray-50">

      {/* SIDEBAR */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col h-screen fixed left-0 top-0">

        {/* LOGO */}
        <div className="p-6 flex items-center space-x-3">
          {/* using uploaded screenshot as placeholder logo (local path) */}
          <img
            src="/market-logo.png"
            alt="MarketHub Logo"
            className="h-10 w-10 object-cover rounded"
          />
          <span className="text-2xl font-bold text-slate-800">
            MarketHub
          </span>
        </div>

        {/* NAVIGATION */}
        <nav className="flex-1 px-4 space-y-1">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `block px-4 py-2 rounded-lg font-medium ${
                isActive
                  ? "bg-sky-100 text-sky-700"
                  : "text-gray-700 hover:bg-gray-100"
              }`
            }
          >
            Dashboard
          </NavLink>

          <NavLink
            to="/tracker"
            className={({ isActive }) =>
              `block px-4 py-2 rounded-lg font-medium ${
                isActive
                  ? "bg-sky-100 text-sky-700"
                  : "text-gray-700 hover:bg-gray-100"
              }`
            }
          >
            My Tracker
          </NavLink>

          <NavLink
            to="/analytics"
            className={({ isActive }) =>
              `block px-4 py-2 rounded-lg font-medium ${
                isActive
                  ? "bg-sky-100 text-sky-700"
                  : "text-gray-700 hover:bg-gray-100"
              }`
            }
          >
            Analytics
          </NavLink>
        </nav>

        {/* SIGN OUT (small, subtle, bottom-left) */}
        <div className="p-4 mt-auto">
          <button
            onClick={handleLogout}
            className="flex items-center space-x-3 text-white-600 hover:text-gray-900 text-sm font-medium transition"
          >
            {/* Correct logout icon: arrow exiting a door */}
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none"
                 viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 17l5-5-5-5v10z"/>
            </svg>

            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex-1 overflow-y-auto ml-64">
        {children}
      </main>
    </div>
  );
}
