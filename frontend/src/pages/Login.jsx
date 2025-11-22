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

        const { data, error } = supabase.auth.signInWithPassword({
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
        <div className = "bg-loginpage-bg bg-cover bg-center h-screen w-full">
            <div className="min-h-screen flex items-center justify-end pr-24">
                <div className="bg-white p-10 rounded-xl shadow-sm w-full max-w-md">
                    <h2 className="text-3xl font-bold mb-8 text-center text-gray-900">Sign in</h2>
                    <form onSubmit={handleLogin} className="space-y-6">
                        <div>
                            <label className="block text-gray-600 text-sm font-medium mb-2" htmlFor="email">
                                Email
                            </label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                    </svg>
                                </div>
                                <input
                                    id="email"
                                    type="email"
                                    placeholder="Enter your email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                    className="pl-10 block w-full border-gray-300 rounded-lg bg-gray-50 border focus:ring-blue-500 focus:border-blue-500 p-2.5 text-sm"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-gray-600 text-sm font-medium mb-2" htmlFor="password">
                                Password
                            </label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                    </svg>
                                </div>
                                <input
                                    id="password"
                                    type={showPassword ? "text" : "password"}
                                    placeholder="Enter your password"
                                    value={password}
                                    onChange={(p) => setPassword(p.target.value)}
                                    required
                                    className="pl-10 block w-full border-gray-300 rounded-lg bg-gray-50 border focus:ring-blue-500 focus:border-blue-500 p-2.5 text-sm"
                                />
                                <div className="absolute inset-y-0 right-0 pr-3 flex items-center cursor-pointer" onClick={() => setShowPassword(!showPassword)}>
                                    {showPassword ? (
                                        <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                        </svg>
                                    ) : (
                                        <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                        </svg>
                                    )}
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
                                Don't have an account? <a href="/signup" className="font-bold text-slate-800 hover:text-slate-900">Sign up</a>
                            </p>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}