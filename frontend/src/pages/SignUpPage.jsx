import { useState } from 'react';
import { supabase } from '../lib/supabase.js';

export default function SignUpPage(){
    const [Email, setEmail] = useState("");
    const [Password, setPassword] = useState("");
    const [FullName, setFullName] = useState("");
    const [Loading, setLoading] = useState(false);
    const [Error, setError] = useState("");
    const [message, setMessage] = useState("");

    async function handleSignUp(e){
        e.preventDefault();
        setError("");
        setMessage("");
        setLoading(true);

        const { error } = await supabase.auth.signup({
            email,
            password
        });

        setLoading(false);

        if(error){
            setError(error.message);
        }
        else{
            setMessage("Sign up successful! Please check your email to confirm your account.");
        }
    }

    return (
        <div className = "flex flex-col items-center justify-center min-h-screen">
            <h1 className = "text-2x1 font-semibold mb-6">Sign Up</h1>
            <form onSubmit={handleSignUp} className = "flex flex-col w-80">
                <input
                    type="text"
                    placeholder="Full Name"
                    value ={FullName}
                    onChange = {(e) => setFullName(e.target.value)}
                    required
                />
                <input
                    type="email"
                    placeholder="Email"
                    value ={Email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                />
                <input
                    type="password"
                    placeholder="Password"
                    value = {Password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                />
                <button
                    type = "submit"
                    className="bg-blue-600 text-white py-2 rounded disabled:bg-blue-400"
                    disabled = {Loading}
                >
                    {Loading ? "Signing Up..." : "Sign Up"}
                </button>
            </form>
            {Error && <p className="text-red-600 text-sm">{Error}</p>}
            {message && <p className="text-green-600 text-sm">{message}</p>}
        </div>
    )
}