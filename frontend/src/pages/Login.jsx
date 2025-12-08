import { useState } from "react";
import { useUserStore } from "../store/useUserStore.js";
import { supabase } from "../lib/supabase.js";

export default function Login() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const setUser = useUserStore((s) => s.setUser);

    async function handleLogin(e) {
        e.preventDefault();

        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            alert(error.message);
            return;
        }

        const session = data.session;
        const user = data.user;

        // Save to Zustand
        setUser({
            userId: user.userId,
            email: user.email,
            role: user.role || user.app_metadata?.role,
            jwt: session.access_token
        });

        window.location.href = '/';
    }

    return (
        <div className="bg-loginpage-bg bg-cover bg-center h-screen w-full">
            <div className="h-full w-full bg-black/40">
                {/* Main layout: left logo section + right form section */}
                <div className="min-h-screen w-full flex items-center justify-between px-24">

                    {/* LEFT: Brand / Logo */}
                    <div className="text-white space-y-6">
                        {/* Logo row */}
                        <div className="flex items-center space-x-5">
                            {/* Logo icon */}
                            <img
                                src="/market-logo.png"
                                alt="MarketHub logo"
                                className="h-38 w-32"
                            />


                            {/* Brand name */}
                            <span className="text-6xl font-extrabold tracking-tight">
                                MarketHub
                            </span>
                        </div>

                        {/* Tagline */}
                        <p className="text-3xl font-semibold text-gray-100 tracking-widest ml-5">
                            Track Smarter. Shop Better
                        </p>
                    </div>

                    {/* RIGHT: Sign in card (your existing code) */}
                    <div className="bg-white p-10 rounded-xl shadow-sm w-full max-w-md">
                        <h2 className="text-3xl font-bold mb-8 text-center text-gray-900">
                            Sign in
                        </h2>

                        <form onSubmit={handleLogin} className="space-y-6">
                            {/* Email */}
                            <div>
                                <label
                                    className="block text-gray-600 text-sm font-medium mb-2"
                                    htmlFor="email"
                                >
                                    Email
                                </label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        {/* email icon */}
                                        <svg
                                            className="h-5 w-5 text-gray-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth={2}
                                                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                                            />
                                        </svg>
                                    </div>
                                    <input
                                        id="email"
                                        type="email"
                                        placeholder="Enter your email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        required
                                        className="pl-10 block w-full border-gray-300 rounded-lg bg-gray-50 border focus:ring-blue-500 focus:border-blue-500 p-2.5 text-sm text-gray-900"
                                    />
                                </div>
                            </div>

                            {/* Password */}
                            <div>
                                <label
                                    className="block text-gray-600 text-sm font-medium mb-2"
                                    htmlFor="password"
                                >
                                    Password
                                </label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <svg
                                            className="h-5 w-5 text-gray-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth={2}
                                                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                                            />
                                        </svg>
                                    </div>
                                    <input
                                        id="password"
                                        type={showPassword ? "text" : "password"}
                                        placeholder="Enter your password"
                                        value={password}
                                        onChange={(p) => setPassword(p.target.value)}
                                        required
                                        className="pl-10 block w-full border-gray-300 rounded-lg bg-gray-50 border focus:ring-blue-500 focus:border-blue-500 p-2.5 text-sm text-gray-900"
                                    />
                                    <div
                                        className="absolute inset-y-0 right-0 pr-3 flex items-center cursor-pointer"
                                        onClick={() => setShowPassword(!showPassword)}
                                    >
                                        {/* your eye / eye-off icons here */}
                                    </div>
                                </div>
                            </div>

                            <button
                                type="submit"
                                className="w-full bg-slate-800 hover:bg-slate-900 text-white font-bold py-3 px-4 rounded-lg focus:outline-none focus:shadow-outline transition duration-300"
                            >
                                Sign in
                            </button>

                            <div className="text-center mt-4">
                                <p className="text-sm text-gray-600">
                                    Don't have an account?{" "}
                                    <a
                                        href="/signup"
                                        className="font-bold text-slate-800 hover:text-slate-900"
                                    >
                                        Sign up
                                    </a>
                                </p>
                                <a
                                    href="/forgot-password"
                                    className="text-sm font-medium text-slate-800 hover:text-slate-900"
                                >
                                    Forgot password?
                                </a>
                            </div>

                        </form>
                    </div>
                </div>
            </div>
        </div>
    );
}