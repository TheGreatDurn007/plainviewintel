"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type Mode = "signin" | "signup" | "forgot";

function getStrength(pw: string): { score: number; label: string; color: string } {
  if (!pw) return { score: 0, label: "", color: "#1e2a35" };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { score, label: "Weak", color: "#ff3d57" };
  if (score <= 3) return { score, label: "Fair", color: "#ffc107" };
  if (score === 4) return { score, label: "Strong", color: "#00b4d8" };
  return { score, label: "Very strong", color: "#00e676" };
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState(""); // optional display name → powers the "Good morning, <name>" greeting
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) router.replace("/");
    });
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setSuccess("");
    setPassword("");
    setConfirm("");
    setShowPw(false);
  }

  const strength = mode === "signup" ? getStrength(password) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");

    if (mode === "forgot") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/api/auth/callback`,
      });
      if (error) {
        setError(error.message);
      } else {
        setSuccess("Check your email for a password reset link.");
        setMode("signin");
      }
      setLoading(false);
      return;
    }

    if (mode === "signup") {
      if (password.length < 8) {
        setError("Password must be at least 8 characters.");
        setLoading(false);
        return;
      }
      if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        setError("Password must contain at least one uppercase letter and one number.");
        setLoading(false);
        return;
      }
      if (password !== confirm) {
        setError("Passwords do not match.");
        setLoading(false);
        return;
      }
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/api/auth/callback`,
          data: { display_name: name.trim() || null }, // greets you by name from day one
        },
      });
      if (error) {
        setError(error.message);
      } else {
        setSuccess("Account created! Check your email to confirm, then sign in.");
        setMode("signin");
        setPassword("");
        setConfirm("");
      }
      setLoading(false);
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push("/home");
      router.refresh();
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          background: #080b0f;
          color: #e8edf2;
          font-family: 'Syne', sans-serif;
          min-height: 100vh;
        }
        .grid-bg {
          position: fixed;
          inset: 0;
          background-image:
            repeating-linear-gradient(0deg, transparent, transparent 39px, #1e2a35 39px, #1e2a35 40px),
            repeating-linear-gradient(90deg, transparent, transparent 39px, #1e2a35 39px, #1e2a35 40px);
          opacity: .12;
          pointer-events: none;
        }
        .glow {
          position: fixed; top: -10%; left: 50%; transform: translateX(-50%);
          width: 900px; height: 520px; pointer-events: none; z-index: 0;
          background: radial-gradient(ellipse at center, rgba(0,230,118,.10), transparent 65%);
        }
        .wrap {
          position: relative;
          z-index: 1;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }
        .layout {
          display: flex;
          align-items: center;
          gap: 60px;
          width: 100%;
          max-width: 940px;
        }
        /* ── Hero (value proposition) ── */
        .hero { flex: 1 1 0; min-width: 0; }
        .hero-logo { display: flex; align-items: center; gap: 13px; margin-bottom: 30px; }
        .hero-title {
          font-family: 'Syne', sans-serif; font-size: 40px; font-weight: 800;
          line-height: 1.04; letter-spacing: -.015em; color: #e8edf2; margin-bottom: 18px;
        }
        .hero-title .accent { color: #00e676; }
        .hero-sub {
          font-size: 14.5px; color: #7a8fa0; line-height: 1.6; max-width: 430px; margin-bottom: 26px;
        }
        .hero-features { list-style: none; display: flex; flex-direction: column; gap: 13px; }
        .hero-features li {
          font-family: 'Space Mono', monospace; font-size: 12px; color: #aeb9c4;
          display: flex; gap: 11px; align-items: flex-start; line-height: 1.45;
        }
        .hf-ico { color: #00e676; flex-shrink: 0; font-size: 11px; line-height: 1.5; }
        .card {
          background: #0e1318;
          border: 1px solid #1e2a35;
          border-radius: 14px;
          padding: 36px 32px;
          width: 100%;
          flex: 0 0 396px;
          box-shadow: 0 24px 70px rgba(0,0,0,.45);
        }
        .card-head { margin-bottom: 22px; }
        .card-head h2 {
          font-family: 'Syne', sans-serif; font-size: 19px; font-weight: 800; color: #e8edf2; letter-spacing: -.01em;
        }
        .card-head p { font-family: 'Space Mono', monospace; font-size: 11px; color: #7a8fa0; margin-top: 4px; }
        @media (max-width: 880px) {
          .layout { flex-direction: column; gap: 30px; max-width: 440px; align-items: stretch; }
          .hero { width: 100%; }
          .hero-logo { justify-content: flex-start; }
          .hero-title { font-size: 30px; }
          .hero-features { display: none; }
          .card { flex: 1 1 auto; }
        }
        /* logo mark (shared) */
        .lmark {
          width: 40px; height: 40px;
          background: #00e676;
          clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
          display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        }
        .lmark span { color: #000; font-size: 15px; font-weight: 700; font-family: 'Space Mono', monospace; }
        .ltxt { font-size: 17px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #e8edf2; line-height: 1; }
        .lsub { font-size: 9px; color: #7a8fa0; letter-spacing: .1em; text-transform: uppercase; font-family: 'Space Mono', monospace; margin-top: 3px; }
        .mode-tabs {
          display: flex;
          background: #141b22;
          border: 1px solid #1e2a35;
          border-radius: 9px;
          padding: 3px;
          margin-bottom: 24px;
          gap: 3px;
        }
        .mode-tab {
          flex: 1; background: transparent; border: none; border-radius: 7px;
          color: #3d5166; font-family: 'Space Mono', monospace; font-size: 10px;
          font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
          padding: 8px 0; cursor: pointer; transition: background .15s, color .15s;
        }
        .mode-tab.active { background: #1e2a35; color: #e8edf2; }
        .field { margin-bottom: 16px; }
        .field label {
          display: block; font-size: 10px; font-weight: 700; letter-spacing: .06em;
          text-transform: uppercase; color: #7a8fa0; margin-bottom: 6px;
          font-family: 'Space Mono', monospace;
        }
        .pw-wrap { position: relative; }
        .pw-wrap input { padding-right: 38px; }
        .pw-toggle {
          position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
          background: none; border: none; cursor: pointer; color: #3d5166;
          font-size: 14px; padding: 2px; line-height: 1;
          transition: color .15s;
        }
        .pw-toggle:hover { color: #7a8fa0; }
        .field input {
          width: 100%; background: #141b22; border: 1px solid #1e2a35;
          border-radius: 8px; color: #e8edf2; font-family: 'Space Mono', monospace;
          font-size: 13px; padding: 10px 13px; outline: none; transition: border-color .15s;
        }
        .field input:focus { border-color: #00e676; }
        .field input::placeholder { color: #3d5166; }
        .strength-bar {
          display: flex; gap: 3px; margin-top: 7px;
        }
        .strength-seg {
          flex: 1; height: 3px; border-radius: 2px;
          background: #1e2a35; transition: background .2s;
        }
        .strength-label {
          font-family: 'Space Mono', monospace; font-size: 9px;
          margin-top: 4px; letter-spacing: .05em;
        }
        .pw-rules {
          font-family: 'Space Mono', monospace; font-size: 10px;
          color: #3d5166; margin-top: 6px; line-height: 1.6;
        }
        .pw-rules span { display: inline-block; margin-right: 10px; }
        .pw-rules span.ok { color: #00e676; }
        .submit-btn {
          width: 100%; background: #00e676; color: #000; border: none;
          border-radius: 8px; font-family: 'Syne', sans-serif; font-size: 13px;
          font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
          padding: 12px; cursor: pointer; margin-top: 8px; transition: opacity .15s;
        }
        .submit-btn:hover { opacity: .88; }
        .submit-btn:disabled { opacity: .4; cursor: not-allowed; }
        .error-msg {
          background: #ff3d5718; border: 1px solid #ff3d5740; border-radius: 7px;
          color: #ff3d57; font-family: 'Space Mono', monospace; font-size: 11px;
          padding: 9px 12px; margin-bottom: 16px; line-height: 1.5;
        }
        .success-msg {
          background: #00e67618; border: 1px solid #00e67640; border-radius: 7px;
          color: #00e676; font-family: 'Space Mono', monospace; font-size: 11px;
          padding: 9px 12px; margin-bottom: 16px; line-height: 1.5;
        }
        .forgot-link {
          background: none; border: none; color: #3d5166; font-family: 'Space Mono', monospace;
          font-size: 10px; cursor: pointer; padding: 0; margin-top: 6px;
          letter-spacing: .04em; transition: color .15s; display: block; text-align: right;
        }
        .forgot-link:hover { color: #7a8fa0; }
        .back-link {
          background: none; border: none; color: #3d5166; font-family: 'Space Mono', monospace;
          font-size: 10px; cursor: pointer; padding: 0; margin-bottom: 20px;
          letter-spacing: .04em; transition: color .15s; display: flex; align-items: center; gap: 5px;
        }
        .back-link:hover { color: #7a8fa0; }
        .footer-note {
          font-size: 9px; color: #3d5166; text-align: center;
          font-family: 'Space Mono', monospace; margin-top: 20px; letter-spacing: .04em;
        }
      `}</style>

      <div className="grid-bg" />
      <div className="glow" />

      <div className="wrap">
        <div className="layout">
          <div className="hero">
            <div className="hero-logo">
              <div className="lmark"><span>P</span></div>
              <div>
                <div className="ltxt">Plainview</div>
                <div className="lsub">Command Center</div>
              </div>
            </div>
            <h1 className="hero-title">Invest with <span className="accent">discipline</span>,<br />not FOMO.</h1>
            <p className="hero-sub">
              Your private command center for tracking positions, x-raying financials,
              and timing entries — with AI intel built to be skeptical, not to hype.
              Synced to your account, on every device.
            </p>
            <ul className="hero-features">
              <li><span className="hf-ico">◆</span> X-Ray any stock, ETF, or crypto — SEC + market data scored 0–10</li>
              <li><span className="hf-ico">◆</span> AI intel briefs: what changed, the real risk, the next catalyst</li>
              <li><span className="hf-ico">◆</span> Buy Zone entry timing + short-squeeze metrics, no guesswork</li>
              <li><span className="hf-ico">◆</span> Your data, locked to your account and synced everywhere</li>
            </ul>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>{mode === "signup" ? "Create your account" : "Welcome back"}</h2>
              <p>{mode === "signup" ? "Start your synced portfolio in seconds." : "Sign in to your command center."}</p>
            </div>

            {mode !== "forgot" && (
            <div className="mode-tabs">
              <button type="button" className={`mode-tab${mode === "signin" ? " active" : ""}`} onClick={() => switchMode("signin")}>
                Sign In
              </button>
              <button type="button" className={`mode-tab${mode === "signup" ? " active" : ""}`} onClick={() => switchMode("signup")}>
                Create Account
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {error && <div className="error-msg">{error}</div>}
            {success && <div className="success-msg">{success}</div>}

            {mode === "forgot" ? (
              <>
                <button type="button" className="back-link" onClick={() => switchMode("signin")}>← Back to sign in</button>
                <div className="card-head" style={{ marginBottom: 20 }}>
                  <h2>Reset password</h2>
                  <p>Enter your email and we&apos;ll send a reset link.</p>
                </div>
                <div className="field">
                  <label>Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com" required autoFocus autoComplete="email" />
                </div>
                <button type="submit" className="submit-btn" disabled={loading}>
                  {loading ? "Sending…" : "Send Reset Link"}
                </button>
              </>
            ) : (
              <>
                {mode === "signup" && (
                  <div className="field">
                    <label>What should we call you? <span style={{ color: "#3d5166", textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                      placeholder="Dar" autoComplete="given-name" maxLength={40} />
                  </div>
                )}
                <div className="field">
                  <label>Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com" required autoFocus autoComplete="email" />
                </div>

                <div className="field">
                  <label>Password</label>
                  <div className="pw-wrap">
                    <input
                      type={showPw ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    />
                    <button type="button" className="pw-toggle" onClick={() => setShowPw(v => !v)} tabIndex={-1} aria-label="Toggle password visibility">
                      {showPw ? "🙈" : "👁"}
                    </button>
                  </div>
                  {mode === "signin" && (
                    <button type="button" className="forgot-link" onClick={() => switchMode("forgot")}>
                      Forgot password?
                    </button>
                  )}
                  {mode === "signup" && password && strength && (
                    <>
                      <div className="strength-bar">
                        {[1, 2, 3, 4, 5].map(i => (
                          <div key={i} className="strength-seg" style={{ background: i <= strength.score ? strength.color : "#1e2a35" }} />
                        ))}
                      </div>
                      <div className="strength-label" style={{ color: strength.color }}>{strength.label}</div>
                      <div className="pw-rules">
                        <span className={password.length >= 8 ? "ok" : ""}>✓ 8+ chars</span>
                        <span className={/[A-Z]/.test(password) ? "ok" : ""}>✓ Uppercase</span>
                        <span className={/[0-9]/.test(password) ? "ok" : ""}>✓ Number</span>
                        <span className={/[^A-Za-z0-9]/.test(password) ? "ok" : ""}>✓ Symbol</span>
                      </div>
                    </>
                  )}
                </div>

                {mode === "signup" && (
                  <div className="field">
                    <label>Confirm Password</label>
                    <div className="pw-wrap">
                      <input
                        type={showPw ? "text" : "password"}
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder="••••••••"
                        required
                        autoComplete="new-password"
                      />
                    </div>
                  </div>
                )}

                <button type="submit" className="submit-btn" disabled={loading}>
                  {loading
                    ? mode === "signup" ? "Creating account…" : "Signing in…"
                    : mode === "signup" ? "Create Account" : "Sign In"}
                </button>
              </>
            )}
          </form>

          <p className="footer-note">
            {mode === "signup"
              ? "Use a unique password you don't use elsewhere · Data encrypted via Supabase"
              : "Data synced via Supabase · Each user has their own data"}
          </p>
          </div>
        </div>
      </div>
    </>
  );
}
