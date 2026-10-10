import { useEffect, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { request, supabase, type Config } from "./api";

type AuthMode = "signin" | "signup";
type Me = { displayName: string; admin: boolean; campus: string };

export function validateAuthFields({ local, mode, name, password, confirmPassword }: { local: boolean; mode: AuthMode; name: string; password: string; confirmPassword: string }) {
  if (local) return name.trim() ? null : "Enter a display name.";
  if (!/^\S+@\S+\.\S+$/.test(name.trim())) return "Enter a valid email address.";
  if (!password || password.length < 6) return "Use a password with at least 6 characters.";
  if (mode === "signup" && password !== confirmPassword) return "Passwords do not match.";
  return null;
}

function friendlyAuthError(error: unknown, mode: AuthMode) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/network|fetch|failed to fetch|timeout/.test(message))
    return "Unable to reach the authentication service. Check your connection and try again.";
  if (/rate limit|too many|over_request_rate_limit/.test(message))
    return "Too many attempts. Wait a moment and try again.";
  if (/email not confirmed|confirm.*email/.test(message))
    return "Please confirm your email before signing in.";
  if (mode === "signin" && /invalid login|invalid credential|password/.test(message))
    return "Incorrect email or password.";
  if (mode === "signup" && /already.*registered|already.*exists|user.*exists/.test(message))
    return "An account already exists for this email. Sign in instead.";
  if (/valid email|invalid.*email/.test(message)) return "Enter a valid email address.";
  if (/password|weak/.test(message))
    return "Use a longer password that meets the password requirements.";
  return mode === "signup" ? "We could not create your account. Try again." : "Unable to sign in. Try again.";
}

export function AuthDialog({
  open,
  config,
  onClose,
  onAuthenticated,
}: {
  open: boolean;
  config: Config | null;
  onClose: () => void;
  onAuthenticated: (me: Me) => void;
}) {
  const [mode, setMode] = useState<AuthMode>("signup");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const local = !!config?.localDemoAuth;
  const clearMessages = () => { setError(""); setNotice(""); };

  useEffect(() => {
    if (!open) { clearMessages(); setPassword(""); setConfirmPassword(""); return; }
    clearMessages();
    queueMicrotask(() => emailRef.current?.focus());
  }, [open]);
  useEffect(() => {
    if (!open) return;
    clearMessages(); setPassword(""); setConfirmPassword("");
  }, [mode]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [open, busy, onClose]);
  if (!open) return null;
  const switchMode = (next: AuthMode) => { setMode(next); };
  async function submit() {
    if (busy) return;
    clearMessages();
    const email = name.trim();
    const validation = validateAuthFields({ local, mode, name, password, confirmPassword });
    if (validation) {
      setError(validation);
      if (/email|display/.test(validation)) emailRef.current?.focus();
      else if (/match/.test(validation)) confirmRef.current?.focus();
      else passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (local) {
        const r = await request<{ token: string }>("/demo/session", { displayName: email });
        sessionStorage.setItem("demo-token", r.token);
        onAuthenticated(await request<Me>("/me"));
        onClose();
        return;
      }
      if (!supabase) throw new Error("authentication unavailable");
      const result = mode === "signup"
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
      if (result.error) { setError(friendlyAuthError(result.error, mode)); return; }
      if (!result.data.session) {
        setNotice("Account created. Check your email to confirm your account before signing in.");
        setPassword(""); setConfirmPassword(""); return;
      }
      onAuthenticated(await request<Me>("/me"));
      onClose();
    } catch (cause) { setError(friendlyAuthError(cause, mode)); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
    <form className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <button className="dialog-close" type="button" onClick={onClose} disabled={busy} aria-label="Close sign in dialog"><X size={18}/></button>
      <div className="eyebrow">WELCOME TO SCARLET</div>
      {!local && <div className="auth-mode" role="tablist" aria-label="Account mode">
        <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "active" : ""} onClick={() => switchMode("signup")}>Create account</button>
        <button type="button" role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "active" : ""} onClick={() => switchMode("signin")}>Sign in</button>
      </div>}
      <h2 id="auth-title">{local ? "Enter the local demo" : mode === "signup" ? "Create your account" : "Sign in to trade"}</h2>
      <p>{local ? "A separate demo wallet starts with $R 1,000." : "Play money only. No cash-out or real-money trading."}</p>
      {error && <p id="auth-error" className="auth-message auth-error" role="alert">{error}{error.startsWith("An account already") && <button type="button" onClick={() => switchMode("signin")}>Sign in instead</button>}</p>}
      {notice && <p className="auth-message auth-notice" role="status">{notice}</p>}
      <label>{local ? "Display name" : "Email"}<input ref={emailRef} type={local ? "text" : "email"} autoComplete={local ? "name" : "email"} value={name} onChange={(e) => { setName(e.target.value); clearMessages(); }} required maxLength={100} aria-invalid={!!error && !local && !/^\S+@\S+\.\S+$/.test(name)} /></label>
      {!local && <><label>Password<input ref={passwordRef} type="password" value={password} onChange={(e) => { setPassword(e.target.value); clearMessages(); }} required minLength={6} autoComplete={mode === "signup" ? "new-password" : "current-password"} aria-invalid={!!error && password.length < 6} /></label>
      {mode === "signup" && <label>Confirm password<input ref={confirmRef} type="password" value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); clearMessages(); }} required minLength={6} autoComplete="new-password" aria-invalid={!!error && password !== confirmPassword} aria-describedby={error && password !== confirmPassword ? "auth-error" : undefined} /></label>}</>}
      <button className="solid" type="submit" disabled={busy}>{busy ? (local ? "Entering demo…" : mode === "signup" ? "Creating account…" : "Signing in…") : local ? "Continue" : mode === "signup" ? "Create account" : "Sign in"} <ArrowRight size={16}/></button>
      <button type="button" className="text-button" onClick={onClose} disabled={busy}>Cancel</button>
    </form>
  </div>;
}

export { friendlyAuthError };
