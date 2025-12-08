// src/pages/ForgotPasswordPage.jsx
import { useState } from "react";
import { supabase } from "../lib/supabase.js";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      // configure redirectTo to the page that handles resetting the password (see notes below)
      const redirectTo = `${window.location.origin}/reset-password/confirm`;
      const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo,
      });

      if (error) {
        setError(error.message || "Failed to request password reset.");
      } else {
        // Supabase returns data but main thing is email was sent
        setMessage(
          "If that email exists in our system, a password reset link has been sent. Check your inbox."
        );
      }
    } catch (err) {
      setError(err?.message || "Unexpected error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-loginpage-bg bg-cover bg-center">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h2 className="text-2xl font-semibold mb-4">Reset your password</h2>

        <p className="text-sm text-gray-600 mb-4">
          Enter the email associated with your account and we'll send a link to reset your password.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-700 mb-1" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="you@example.com"
            />
          </div>

          <button
            type="submit"
            className="w-full bg-slate-800 text-white py-2 rounded hover:bg-slate-900 disabled:opacity-60"
            disabled={loading}
          >
            {loading ? "Sending..." : "Send reset email"}
          </button>
        </form>

        {message && <p className="mt-4 text-green-600">{message}</p>}
        {error && <p className="mt-4 text-red-600">{error}</p>}
      </div>
    </div>
  );
}
