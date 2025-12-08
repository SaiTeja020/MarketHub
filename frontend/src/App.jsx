// App.jsx (routes portion)
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useEffect } from "react";
import { supabase } from "./lib/supabase.js";
import { useUserStore } from "./store/useUserStore.js";

import Layout from "./components/Layout.jsx";
import RequireAuth from "./components/RequireAuth.jsx";

import Login from "./pages/Login.jsx";
import Home from "./pages/Home.jsx";
import ProductPage from "./pages/ProductPage.jsx";
import TrackerPage from "./pages/TrackerPage.jsx";
import AnalyticsPage from "./pages/AnalyticsPage.jsx";
import SignUpPage from "./pages/SignUpPage.jsx";
import ForgotPasswordPage from "./pages/ForgotPasswordPage.jsx"; // ensure exact casing
import ResetPasswordPage from "./pages/ResetPasswordPage.jsx";

function App() {
  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "TOKEN_REFRESHED" && session) {
        useUserStore.getState().setUser({
          ...useUserStore.getState().user,
          jwt: session.access_token,
        });
      }
    });

    return () => {
      // defensive unsubscribe
      if (listener?.subscription?.unsubscribe) listener.subscription.unsubscribe();
    };
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password/confirm" element={<ResetPasswordPage />} />
        <Route path="/signup" element={<SignUpPage />} />

        {/* Protected */}
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout>
                <Home />
              </Layout>
            </RequireAuth>
          }
        />

        <Route
          path="/tracker"
          element={
            <RequireAuth>
              <Layout>
                <TrackerPage />
              </Layout>
            </RequireAuth>
          }
        />

        {/* Analytics: support both index and explicit id routes */}
        <Route
          path="/analytics"
          element={
            <RequireAuth>
              <Layout>
                <AnalyticsPage />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/analytics/:id"
          element={
            <RequireAuth>
              <Layout>
                <AnalyticsPage />
              </Layout>
            </RequireAuth>
          }
        />

        <Route
          path="/product/:id"
          element={
            <RequireAuth>
              <Layout>
                <ProductPage />
              </Layout>
            </RequireAuth>
          }
        />

        {/* Optional: fallback 404 */}
        <Route path="*" element={<div>404 — Not Found</div>} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
