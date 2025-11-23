import { useState } from 'react';
import { supabase } from '../lib/supabase.js';

export default function SignUpPage() {
    const [fullName, setFullName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [repassword, setRepassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");

    async function handleSignUp(e) {
        e.preventDefault();
        setError("");
        setMessage("");
        setLoading(true);

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    full_name: fullName
                }
            }
        });

        setLoading(false);

        if (error) {
            setError(error.message);
        } else {
            setMessage("Sign up successful! Please check your email to confirm your account.");
        }
    }

    return (
        <div className="bg-loginpage-bg bg-cover bg-center h-screen w-full">
            <div className="h-full w-full bg-black/40">
                <div className="min-h-screen w-full flex items-center justify-between px-24">

                    {/* LEFT: Brand / Logo */}
                    <div className="text-white space-y-6">
                        <div className="flex items-center space-x-5">
                            <img
                                src="/market-logo.png"
                                alt="MarketHub logo"
                                className="h-38 w-32"
                            />
                            <span className="text-6xl font-extrabold tracking-tight">
                                MarketHub
                            </span>
                        </div>

                        <p className="text-3xl font-semibold text-gray-100 tracking-widest ml-5">
                            Track Smarter. Shop Better
                        </p>
                    </div>

                    {/* RIGHT: Sign Up Card */}
                    <div className="bg-white p-10 rounded-xl shadow-sm w-full max-w-md">
                        <h2 className="text-3xl font-bold mb-8 text-center text-gray-900">
                            Sign Up
                        </h2>

                        <form onSubmit={handleSignUp} className="space-y-6">

                            {/* FULL NAME */}
                            <div>
                                <label
                                    className="block text-gray-600 text-sm font-medium mb-2"
                                    htmlFor="fullname"
                                >
                                    Full Name
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
                                                d="M5.121 17.804A4 4 0 018 17h8a4 4 0 012.879 1.196M12 12a4 4 0 100-8 4 4 0 000 8z"
                                            />
                                        </svg>
                                    </div>
                                    <input
                                        id="fullname"
                                        type="text"
                                        placeholder="Enter your full name"
                                        value={fullName}
                                        onChange={(e) => setFullName(e.target.value)}
                                        required
                                        className="pl-10 block w-full border-gray-300 rounded-lg bg-gray-50 border 
                                                   focus:ring-blue-500 focus:border-blue-500 p-2.5 text-sm text-gray-900"
                                    />
                                </div>
                            </div>

                            {/* EMAIL */}
                            <div>
                                <label
                                    className="block text-gray-600 text-sm font-medium mb-2"
                                    htmlFor="email"
                                >
                                    Email
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
                                        className="pl-10 block w-full border-gray-300 rounded-lg bg-gray-50 border 
                                                   focus:ring-blue-500 focus:border-blue-500 p-2.5 text-sm text-gray-900"
                                    />
                                </div>
                            </div>

                            {/* PASSWORD */}
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
                                        onChange={(e) => setPassword(e.target.value)}
                                        required
                                        className="pl-10 block w-full border-gray-300 rounded-lg bg-gray-50 border 
                                                   focus:ring-blue-500 focus:border-blue-500 p-2.5 text-sm text-gray-900"
                                    />
                                    <div
                                        className="absolute inset-y-0 right-0 pr-3 flex items-center cursor-pointer"
                                        onClick={() => setShowPassword(!showPassword)}
                                    >
                                        {/* eye icon optional */}
                                    </div>
                                </div>
                            </div>

                            {/* BUTTON */}
                            <button
                                type="submit"
                                className="w-full bg-slate-800 hover:bg-slate-900 text-white font-bold py-3 px-4 rounded-lg 
                                           focus:outline-none focus:shadow-outline transition duration-300"
                                disabled={loading}
                            >
                                {loading ? "Signing Up..." : "Sign Up"}
                            </button>

                            {/* LOGIN LINK */}
                            <div className="text-center mt-4">
                                <p className="text-sm text-gray-600">
                                    Already have an account?{" "}
                                    <a
                                        href="/login"
                                        className="font-bold text-slate-800 hover:text-slate-900"
                                    >
                                        Sign in
                                    </a>
                                </p>
                            </div>
                        </form>

                        {error && <p className="text-red-600 text-sm mt-3">{error}</p>}
                        {message && <p className="text-green-600 text-sm mt-3">{message}</p>}
                    </div>
                </div>
            </div>
        </div>
    );
}
