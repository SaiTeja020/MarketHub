import { useState } from "react";
import { useUserStore } from "../store/useUserStore.js";
import { supabase } from "../lib/supabase.js";

export default function Login() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const setUser = useUserStore((s) => s.setUser);

    async function handleLogin(e){
        e.preventDefault();

        const { data, error } = supabase.auth.signInWithPassword({
            email,
            password
        });

        if(error){
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

    return(
        <div style = {{ width: 350, margin: "50px auto"}}>
            <h2>Login</h2>
            <form onSubmit={handleLogin}>
                <input
                    type = "email"
                    placeholder = "Email"
                    value = {email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    /><br /><br />
                
                <input
                    type = "password"
                    placeholder = "Enter Password"
                    value = {password}
                    onChange={(p) => setPassword(p.target.value)}
                    required
                    /><br /><br />
                
                <button type="submit">Login</button>
            </form>
        </div>
    );
}