import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useEffect } from "react";
import { supabase } from "./lib/supabase.js";
import { useUserStore } from "./store/useUserStore.js";

import Layout from "./components/Layout.jsx";
import RequireAuth from './components/RequireAuth.jsx';

import Login from "./pages/Login.jsx";
import Home from "./pages/Home.jsx";
import ProductPage from "./pages/ProductPage.jsx";
import TrackerPage from "./pages/TrackerPage.jsx";
import AnalyticsPage from "./pages/AnalyticsPage.jsx";

function App() {
    useEffect(() => {
        const { data: listener } = supabase.auth.onAuthStateChange(
            (event, session) => {
                if (event === "TOKEN_REFRESHED" && session) {
                    useUserStore.getState().setUser({
                        ...useUserStore.getState().user,
                        jwt: session.access_token
                    });
                }
            }
        );

        return () => listener.subscription.unsubscribe();
    }, []);

    return (
        <Routes>
            <Route path="/login" element={<Login />} />
            <Route
                path='/'
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
                path="/product/:id"
                element={
                    <RequireAuth>
                        <Layout>
                            <ProductPage />
                        </Layout>
                    </RequireAuth>
                }
            />
        </Routes>
    );
}

export default App;