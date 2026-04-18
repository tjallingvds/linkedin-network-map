/**
 * Split-screen auth — sign in + create account in a single page with a
 * sliding tab. Real backend: calls login/signup in lib/auth.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { login, signup } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  // Both /login and /signup route here. /signup opens on the "Create account" tab.
  const initial: "signin" | "signup" = loc.pathname === "/signup" ? "signup" : "signin";

  const [tab, setTab] = useState<"signin" | "signup">(initial);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState<{ kind: "err" | "ok"; msg: string } | null>(null);

  const isSignin = tab === "signin";

  const switchTab = (t: "signin" | "signup") => {
    setTab(t);
    setAlert(null);
    setPassword("");
    nav(t === "signin" ? "/login" : "/signup", { replace: true });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setAlert(null);
    if (!email.includes("@") || !email.includes(".")) {
      setAlert({ kind: "err", msg: "Enter a valid email address." });
      return;
    }
    if (password.length < 8) {
      setAlert({ kind: "err", msg: "Password must be at least 8 characters." });
      return;
    }
    if (!isSignin && !name.trim()) {
      setAlert({ kind: "err", msg: "What should we call you?" });
      return;
    }

    setLoading(true);
    try {
      if (isSignin) {
        await login(email, password);
      } else {
        await signup(email, password, name.trim() || undefined);
      }
      nav("/", { replace: true });
    } catch (err) {
      setAlert({ kind: "err", msg: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="l-page">
      <div className="l-left">
        <form className="l-form" onSubmit={submit} noValidate>
          <div className="l-wordmark">
            <span className="l-mark"><span className="l-mark-dot" /></span>
            <span className="l-word">Nontrivial</span>
          </div>

          <div className="l-heading">
            <h1 className={`l-title ${isSignin ? "" : "su"}`}>
              {isSignin ? "Welcome back." : "Make something nontrivial."}
            </h1>
            <p className="l-sub">
              {isSignin
                ? "Sign in to pick up where you left off."
                : "Create an account and we'll have the workspace ready in a minute."}
            </p>
          </div>

          <div className="l-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={isSignin}
              className={isSignin ? "active" : ""} onClick={() => switchTab("signin")}>
              Sign in
            </button>
            <button type="button" role="tab" aria-selected={!isSignin}
              className={!isSignin ? "active" : ""} onClick={() => switchTab("signup")}>
              Create account
            </button>
            <span className="l-tab-slider" data-pos={isSignin ? 0 : 1} />
          </div>

          <div className="l-fields">
            {!isSignin && (
              <Field label="Your name">
                <input value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="name" />
              </Field>
            )}
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                autoFocus={isSignin} autoComplete="email" />
            </Field>
            <Field label="Password" hint={!isSignin ? "At least 8 characters." : undefined}>
              <input type={showPw ? "text" : "password"} value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isSignin ? "current-password" : "new-password"} />
              <button type="button" className="l-eye" onClick={() => setShowPw((s) => !s)} tabIndex={-1}
                aria-label={showPw ? "Hide password" : "Show password"}>
                {showPw ? <EyeOn /> : <EyeOff />}
              </button>
            </Field>
          </div>

          {alert && (
            <div className={`l-alert ${alert.kind}`}>
              <span className="l-alert-dot" />
              <span>{alert.msg}</span>
            </div>
          )}

          {isSignin && (
            <label className="l-check" style={{ marginTop: -4 }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span className="l-check-box" />
              <span>Keep me signed in</span>
            </label>
          )}

          <button type="submit" className="l-submit" disabled={loading}>
            {loading ? (<><span className="l-spin" /><span>Signing you in…</span></>) : (
              <span>{isSignin ? "Sign in" : "Create account"}</span>
            )}
          </button>

          <div className="l-divider">or</div>

          <a href="/api/auth/google" className="l-google">
            <GoogleMark /> Continue with Google
          </a>

          <div className="l-legal">© 2026 Nontrivial</div>
        </form>
      </div>

      <div className="l-right">
        <div className="l-ambient">
          <div className="l-blob l-blob-1" />
          <div className="l-blob l-blob-2" />
          <div className="l-blob l-blob-3" />
        </div>
        <div className="l-stage">
          <div className="l-orb-wrap">
            <div className="l-ring l-ring-1" />
            <div className="l-ring l-ring-2" />
            <div className="l-ring l-ring-3" />
            <div className="l-orb" />
          </div>
          <div className="l-stage-caption">
            <h2>Research, reach out, and&nbsp;close —<br />all in one quiet&nbsp;place.</h2>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Sub-components ----------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const [focus, setFocus] = useState(false);
  return (
    <label className={`l-field ${focus ? "focus" : ""}`}>
      <span className="l-field-label">{label}</span>
      <div className="l-field-input-row" onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}>
        {children}
      </div>
      {hint && <div className="l-field-hint">{hint}</div>}
    </label>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.93 37.95 46.98 31.74 46.98 24.55z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}

function EyeOn() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-6.5 0-10-8-10-8a18.5 18.5 0 0 1 4.24-5.17M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.71 6.71 2 2M22 22l-4.71-4.71M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    </svg>
  );
}
