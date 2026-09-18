import { useEffect, useMemo, useState } from "react";
import logoLight from "./assets/logo-light.png";
import { otpRequest, otpVerify, getAccount, type Company, type LedgerEntry } from "./api";
import { Dashboard } from "./screens/Dashboard";
import { Bookings } from "./screens/Bookings";
import { Approvals } from "./screens/Approvals";
import { Employees } from "./screens/Employees";

const TOKEN_KEY = "flz_biz_token";
type Screen = "dashboard" | "bookings" | "approvals" | "employees";

export function App() {
  const [booting, setBooting] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [screen, setScreen] = useState<Screen>("dashboard");

  // Splash for a moment, then try to restore a saved session.
  useEffect(() => {
    const t = window.setTimeout(async () => {
      const saved = localStorage.getItem(TOKEN_KEY);
      if (saved) {
        try {
          const res = await getAccount(saved);
          setToken(saved);
          setCompany(res.company);
          setLedger(res.ledger);
        } catch {
          localStorage.removeItem(TOKEN_KEY);
        }
      }
      setBooting(false);
    }, 1600);
    return () => window.clearTimeout(t);
  }, []);

  const onAuthed = async (tok: string, comp: Company) => {
    localStorage.setItem(TOKEN_KEY, tok);
    setToken(tok);
    setCompany(comp);
    try {
      const res = await getAccount(tok);
      setLedger(res.ledger);
      setCompany(res.company);
    } catch {
      /* ledger is optional for first paint */
    }
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setCompany(null);
    setLedger([]);
    setScreen("dashboard");
  };

  if (booting) return <Splash />;
  if (!token || !company) return <Login onAuthed={onAuthed} />;

  return (
    <Shell company={company} screen={screen} setScreen={setScreen} logout={logout}>
      {screen === "dashboard" && <Dashboard company={company} ledger={ledger} />}
      {screen === "bookings" && <Bookings company={company} />}
      {screen === "approvals" && <Approvals />}
      {screen === "employees" && <Employees primaryContact={company.contact} />}
    </Shell>
  );
}

function Splash() {
  return (
    <div className="splash">
      <img src={logoLight} alt="Flighterz" />
      <div className="tag">
        Flighterz <b>Intelligent Business Platform</b>
      </div>
      <div className="bar">
        <span />
      </div>
    </div>
  );
}

function Login({ onAuthed }: { onAuthed: (token: string, company: Company) => void }) {
  const [step, setStep] = useState<"creds" | "otp">("creds");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [otpToken, setOtpToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const errText = (e: string) =>
    ({
      credentials: "Incorrect email or password.",
      rate: "Too many attempts. Please wait a few minutes.",
      email: "We couldn't send the code. Try again shortly.",
      otp: "That code is incorrect or expired.",
    })[e] ?? "Something went wrong. Please try again.";

  const submitCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await otpRequest(email.trim(), password);
      setOtpToken(res.otpToken);
      setStep("otp");
    } catch (err) {
      setError(errText((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await otpVerify(email.trim(), code.trim(), otpToken);
      onAuthed(res.token, res.company);
    } catch (err) {
      setError(errText((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <img src={logoLight} alt="Flighterz" style={{ filter: "invert(1)" }} />
        <p className="sub">Intelligent Business Platform — corporate sign in</p>
        {error && <div className="error">{error}</div>}

        {step === "creds" ? (
          <form onSubmit={submitCreds}>
            <label className="field">
              <span>Work email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button className="btn" disabled={busy}>
              {busy ? "…" : "Continue"}
            </button>
            <p className="hint">Accounts are created by Flighterz. There is no self-registration.</p>
          </form>
        ) : (
          <form onSubmit={submitOtp}>
            <label className="field">
              <span>Verification code</span>
              <input
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="6-digit code sent to your email"
                autoFocus
                required
              />
            </label>
            <button className="btn" disabled={busy}>
              {busy ? "…" : "Sign in"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setStep("creds")}>
              Back
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function Shell({
  company,
  screen,
  setScreen,
  logout,
  children,
}: {
  company: Company;
  screen: Screen;
  setScreen: (s: Screen) => void;
  logout: () => void;
  children: React.ReactNode;
}) {
  const nav: { key: Screen; label: string }[] = useMemo(
    () => [
      { key: "dashboard", label: "Analytics" },
      { key: "bookings", label: "Bookings" },
      { key: "approvals", label: "Approval policies" },
      { key: "employees", label: "Employee tree" },
    ],
    [],
  );
  const title = nav.find((n) => n.key === screen)?.label ?? "";

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <img src={logoLight} alt="Flighterz" />
        </div>
        <nav className="nav">
          {nav.map((n) => (
            <button key={n.key} className={screen === n.key ? "active" : ""} onClick={() => setScreen(n.key)}>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="foot">
          <div className="co">{company.name}</div>
          <div>Account {company.accountNo}</div>
          <button className="btn ghost" style={{ color: "rgba(255,255,255,0.8)" }} onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <h1>{title}</h1>
          <span className="who">
            {company.contact} · {company.name}
          </span>
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
