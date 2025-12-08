// src/pages/ResetPasswordPage.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase.js";
import { useNavigate } from "react-router-dom";

export default function ResetPasswordPage() {
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState("");
  const [isRecoverySession, setIsRecoverySession] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // If user clicked the password-reset link, Supabase will sign them in
    // and emit a PASSWORD_RECOVERY event. Alternatively we can check session.
    let mounted = true;
    async function checkSession() {
      try {
        const { data } = await supabase.auth.getSession();
        // data.session will be present if the user is signed in (e.g. from reset link)
        if (!mounted) return;
        if (data?.session) {
          setIsRecoverySession(true);
        } else {
          setIsRecoverySession(false);
          setStatusMsg(
            "It looks like you didn't arrive here via a valid password reset link. Please request a new reset email."
          );
        }
      } catch (err) {
        console.error("session check failed", err);
        if (!mounted) return;
        setIsRecoverySession(false);
        setStatusMsg("Unable to verify reset session. Try requesting a new reset email.");
      }
    }

    checkSession();

    // Also listen for auth events (optional)
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setIsRecoverySession(!!session);
      }
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe && sub.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setStatusMsg("");

    if (!isRecoverySession) {
      setError("No valid reset session. Please request a new reset email.");
      return;
    }

    if (!newPassword || newPassword.length < 6) {
      setError("Password should be at least 6 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      // Update the signed-in user's password
      const { data, error } = await supabase.auth.updateUser({ password: newPassword });

      if (error) {
        setError(error.message || "Failed to update password.");
      } else {
        setStatusMsg("Password updated successfully. Redirecting to login...");
        // optional: sign out so user can login again
        await supabase.auth.signOut();
        setTimeout(() => navigate("/login"), 1200);
      }
    } catch (err) {
      console.error("updateUser error", err);
      setError(err?.message || "Unexpected error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-loginpage-bg bg-cover bg-center">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h2 className="text-2xl font-semibold mb-4 text black">Set a new password</h2>

        {!isRecoverySession ? (
          <div>
            <p className="text-sm text-gray-600 mb-4">
              {statusMsg || "We couldn't verify a password recovery session."}
            </p>
            <div className="flex gap-2">
              <a href="/forgot-password" className="text-sm text-slate-800 underline">
                Request a new reset email
              </a>
              <a href="/login" className="text-sm text-gray-600 ml-auto">
                Back to login
              </a>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-700 mb-1">New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                className="w-full border rounded px-3 py-2 text-sm"
                placeholder="Enter new password"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-700 mb-1">Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                className="w-full border rounded px-3 py-2 text-sm"
                placeholder="Confirm new password"
              />
            </div>

            <button
              type="submit"
              className="w-full bg-slate-800 text-white py-2 rounded hover:bg-slate-900 disabled:opacity-60"
              disabled={loading}
            >
              {loading ? "Updating..." : "Update password"}
            </button>

            {statusMsg && <p className="mt-3 text-green-600">{statusMsg}</p>}
            {error && <p className="mt-3 text-red-600">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
