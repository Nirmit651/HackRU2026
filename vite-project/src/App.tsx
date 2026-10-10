import { useEffect, useState, useCallback, lazy, Suspense } from "react";
import { AutomationAdmin, AutomationDetails } from "./Automation";
import { AuthDialog } from "./AuthDialog";
import { DemoSimulation } from "./DemoSimulation";
import {
  ArrowUpRight,
  ArrowLeft,
  Search,
  ArrowRight,
  Wallet,
  BarChart3,
  Trophy,
  Settings,
  Check,
  Sun,
  Bus,
  CloudRain,
  Flag,
  LogOut,
  Clock3,
  FileText,
  CircleHelp,
  Timer,
} from "lucide-react";
import {
  configure,
  request,
  supabase,
  dollars,
  date,
  type Config,
} from "./api";
const MarketChart = lazy(() =>
  import("./Chart").then((m) => ({ default: m.MarketChart })),
);
const BusMap = lazy(() =>
  import("./BusMap").then((m) => ({ default: m.BusMap })),
);
import type { EnvironmentView, History, PublicMarket } from "../shared/contracts";
import { categories, campuses } from "../shared/contracts";
import "./App.css";
import { marketTemplate } from "../shared/templates";
const labels: Record<string, string> = {
  TEMPERATURE: "Temperature",
  BUS_ARRIVAL: "Bus arrivals",
  RAINFALL: "Rainfall",
  VARSITY_SPORTS: "Varsity sports",
  PRESENTATION_DEMO: "Presentation demo",
};
const icons = {
  TEMPERATURE: Sun,
  BUS_ARRIVAL: Bus,
  RAINFALL: CloudRain,
  VARSITY_SPORTS: Flag,
  PRESENTATION_DEMO: Timer,
};
const payoutMultiple = (price: string | number) => {
  const value = Number(price);
  return value > 0 ? 1 / value : 0;
};
const multipleLabel = (price: string | number) =>
  `${payoutMultiple(price).toFixed(2)}×`;
type Me = { displayName: string; admin: boolean; campus: string };
function friendlyTradeError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/closed|not open/.test(message)) return "Market closed.";
  if (/price|version|slippage/.test(message)) return "Price changed. Review the updated quote and try again.";
  if (/insufficient|balance|fund/.test(message)) return "Insufficient funds.";
  if (/opposite|position/.test(message)) return "Sell your existing side before buying the opposite side.";
  if (/quantity|share/.test(message)) return "Enter a valid number of shares.";
  if (/auth|sign in|unauthor/.test(message)) return "Authentication required. Sign in to trade.";
  if (/network|fetch|timeout/.test(message)) return "Network unavailable. Check your connection and try again.";
  return "Unable to place this order. Try again.";
}
type Position = {
  id: string;
  yesShares: string;
  noShares: string;
  totalCostMicros: string;
  market: PublicMarket;
  payout: { amountMicros: string } | null;
};
type Receipt = {
  receipt: Record<string, unknown>;
  receiptHash: string;
  personal: {
    yesShares: string;
    noShares: string;
    originalCostMicros: string;
    payoutMicros: string;
    netProfitMicros: string;
  } | null;
  verification: { status: string };
};
function MarketSparkline({ market }: { market: PublicMarket }) {
  const [values, setValues] = useState<number[]>([]);
  useEffect(() => {
    let active = true;
    if (market.status !== "OPEN") return;
    request<History>(`/markets/${market.id}/history?range=1D`)
      .then((history) => {
        const prices = history.events
          .filter((event) => event.kind === "PRICE_CHANGED")
          .map((event) => Number(event.yesPrice))
          .filter((price) => Number.isFinite(price) && price >= 0 && price <= 1);
        if (active && prices.length) setValues(prices);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [market.id, market.status, market.version]);
  const points = values.slice(-32);
  const displayed = points.length ? points : [Number(market.yesPrice)];
  const coordinates = displayed.map((value, index) => {
    const x = displayed.length === 1 ? 80 : (index / (displayed.length - 1)) * 160;
    return `${x.toFixed(1)},${(42 - value * 38).toFixed(1)}`;
  });
  const line = coordinates.join(" ");
  const fill = line ? `0,44 ${line} 160,44` : "";
  return <svg className="market-sparkline" viewBox="0 0 160 44" role="img" aria-label={points.length > 1 ? "Market price history" : "Current market price; no completed trades yet"}>
    <title>Market price history</title>
    {points.length > 1 && fill && <polygon points={fill} />}
    {points.length > 1 ? <polyline points={line} /> : <circle cx="80" cy={coordinates[0]?.split(",")[1]} r="3.5" />}
  </svg>;
}
export default function App() {
  const [config, setConfig] = useState<Config | null>(null),
    [envs, setEnvs] = useState<EnvironmentView[]>([]),
    [environmentId, setEnvironmentId] = useState(""),
    [markets, setMarkets] = useState<PublicMarket[]>([]),
    [selected, setSelected] = useState<PublicMarket | null>(null),
    [selectedSide, setSelectedSide] = useState<"YES" | "NO">("YES"),
    [view, setView] = useState("markets"),
    [category, setCategory] = useState(""),
    [status, setStatus] = useState(""),
    [search, setSearch] = useState(""),
    [me, setMe] = useState<Me | null>(null),
    [balance, setBalance] = useState<string>("0"),
    [error, setError] = useState(""),
    [login, setLogin] = useState(false),
    [notice, setNotice] = useState(""),
    [demoAdmin, setDemoAdmin] = useState(false),
    [demoAdminLogin, setDemoAdminLogin] = useState(false),
    [refresh, setRefresh] = useState(0);
  const env = envs.find((e) => e.id === environmentId);
  const refreshAccount = useCallback(() => {
    if (environmentId && me)
      void request<{ balanceMicros: string }>(
        `/me/wallet?environmentId=${environmentId}`,
      )
        .then((w) => setBalance(w.balanceMicros))
        .catch(() => {});
    setRefresh((n) => n + 1);
  }, [environmentId, me]);
  useEffect(() => {
    configure()
      .then((c) => {
        setConfig(c);
        request<Me>("/me")
          .then(setMe)
          .catch(() => {});
      })
      .catch(() =>
        setError(
          "The API is unavailable. Start the API and database to load markets.",
        ),
      );
    request<EnvironmentView[]>("/environments")
      .then((e) => {
        setEnvs(e);
        const saved = localStorage.getItem("environment");
        setEnvironmentId(e.find((v) => v.id === saved)?.id ?? e[0]?.id ?? "");
      })
      .catch(() => {});
    request<Me>("/me")
      .then(setMe)
      .catch(() => {});
    request<{ active: boolean }>("/demo-admin/session")
      .then((r) => setDemoAdmin(r.active))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!environmentId) return;
    localStorage.setItem("environment", environmentId);
    let stopped = false;
    const params = new URLSearchParams({
      environmentId,
      ...(category ? { category } : {}),
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
    });
    request<{ items: PublicMarket[] }>(`/markets?${params}`)
      .then((r) => {
        if (!stopped) setMarkets(r.items);
      })
      .catch((e) => setError(e.message));
    return () => {
      stopped = true;
    };
  }, [environmentId, category, status, search, refresh]);
  useEffect(() => {
    if (me) refreshAccount();
  }, [me, refreshAccount]);
  useEffect(() => {
    if (!environmentId) return;
    const timer = setInterval(refreshAccount, 5000);
    return () => clearInterval(timer);
  }, [environmentId, refreshAccount]);
  useEffect(() => {
    if (!selected) return;
    let stopped = false;
    request<PublicMarket>(`/markets/${selected.id}`).then((m) => {
      if (!stopped) setSelected(m);
    });
    return () => {
      stopped = true;
    };
  }, [refresh, selected?.id]);
  async function logout() {
    await supabase?.auth.signOut();
    sessionStorage.removeItem("demo-token");
    setMe(null);
    setBalance("0");
  }
  return (
    <div className="app-shell">
      <header>
        <a className="brand" href="/" aria-label="Scarlet market home">
          <span className="brand-mark">
            s<span>↗</span>
          </span>
          <span>
            scarlet<span className="brand-sub">MARKET</span>
          </span>
        </a>
        <nav>
          {[
            ["markets", "Markets", BarChart3],
            ["portfolio", "Portfolio", Wallet],
            ["leaderboard", "Leaderboard", Trophy],
            ...(me?.admin ? [["admin", "Admin", Settings]] : []),
          ].map(([key, label, Icon]) => (
            <button
              key={String(key)}
              className={view === key ? "nav-active" : ""}
              onClick={() => {
                setView(String(key));
                setSelected(null);
              }}
            >
              {typeof Icon !== "string" && <Icon size={16} />}
              <span>{String(label)}</span>
            </button>
          ))}
        </nav>
        <div className="account">
          <button
            className="outline demo-admin-button"
            onClick={() =>
              demoAdmin
                ? request("/demo-admin/session", undefined, "DELETE").finally(() => setDemoAdmin(false))
                : setDemoAdminLogin(true)
            }
          >
            {demoAdmin ? "Leave admin mode" : "Become admin"}
          </button>
          {me ? (
            <>
              <span className="cash">{dollars(balance)}</span>
              <button
                className="avatar"
                title={`Sign out ${me.displayName}`}
                onClick={logout}
              >
                {me.displayName[0]}
                <LogOut size={12} />
              </button>
            </>
          ) : (
            <button className="solid" onClick={() => setLogin(true)}>
              Join the market <ArrowUpRight size={15} />
            </button>
          )}
        </div>
      </header>
      <div className="environment-bar">
        <div
          data-label={
            env?.kind === "DEMO"
              ? "DEMO · SIMULATED OUTCOMES"
              : "LIVE EVENTS · PLAY MONEY"
          }
        >
          <span className="dot" />
          {env?.kind === "DEMO"
            ? "DEMO RUN · SIMULATED OUTCOMES"
            : "CAMPUS MARKETS · PLAY MONEY"}
          <span className="bar-divider" />
          Trade while markets are open. No real money.
        </div>
        <select
          aria-label="Environment"
          value={environmentId}
          onChange={(e) => {
            setEnvironmentId(e.target.value);
            setSelected(null);
          }}
        >
          <option value="" disabled>
            Select environment
          </option>
          {envs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.key} · {e.kind}
            </option>
          ))}
        </select>
        <DemoSimulation env={env} authorized={!!me?.admin} onRefresh={() => { refreshAccount(); void request<EnvironmentView[]>("/environments").then(setEnvs); }} />
      </div>
      {error && (
        <div role="alert" className="alert">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          {notice}
          <button onClick={() => setNotice("")}>Dismiss</button>
        </div>
      )}
      <main>
        {view === "markets" && !selected && (
          <>
            <div className="page-heading market-hero">
              <div className="eyebrow">SCARLET MARKET · PLAY MONEY</div>
              <div className="headline-row">
                <h1>
                  Trade on what <em>happens next.</em>
                </h1>
                <p>
                  Rutgers events. Clear odds.
                  <br />
                  Your call, with play money.
                </p>
              </div>
              {demoAdmin && <button className="outline" onClick={() => request<{ market: PublicMarket }>("/presentation/create", {}).then((r) => { setSelected(r.market); setView("markets"); refreshAccount(); }).catch((e) => setError(e.message))}>Create presentation demo</button>}
            </div>
            <div className="discovery-tools">
              <label className="search">
                <Search size={18} />
                <input
                  aria-label="Search markets"
                  placeholder="Search markets (Rutgers, weather, buses...)"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="category-tabs">
                <button
                  className={!category ? "active" : ""}
                  onClick={() => setCategory("")}
                >
                  All markets
                </button>
                {categories.map((c) => (
                  <button
                    key={c}
                    className={category === c ? "active" : ""}
                    onClick={() => setCategory(c)}
                  >
                    {labels[c]}
                  </button>
                  ))}
              </div>
              <select
                aria-label="Market status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">All statuses</option>
                {["OPEN", "PAUSED", "CLOSED", "RESOLVED", "VOIDED"].map(
                  (s) => (
                    <option key={s}>{s}</option>
                  ),
                )}
              </select>
            </div>
            <div className="market-list">
              {markets.map((m, i) => {
                const Icon = icons[m.category];
                const yesPrice = Number(m.yesPrice);
                const noPrice = 1 - yesPrice;
                return (
                  <article
                    className="market-card"
                    key={m.id}
                    style={{ animationDelay: `${i * 40}ms` }}
                    onClick={() => { setSelectedSide("YES"); setSelected(m); }}
                    onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setSelectedSide("YES"); setSelected(m); } }}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open ${m.title}`}
                  >
                    <div className="market-card-top">
                      <div className="market-meta">
                        <span className="market-icon">
                          <Icon size={17} strokeWidth={2} />
                        </span>
                        <span className="category-badge">{labels[m.category]}</span>
                        <span className="market-status"><i />{m.status}</span>
                      </div>
                      <span className="market-close">Closes {date(m.closesAt)}</span>
                    </div>
                    <h2>{m.title}</h2>
                    <div className="market-card-body">
                      <MarketSparkline market={m} />
                      <div className="card-probability">
                        <strong>{(yesPrice * 100).toFixed(0)}%</strong>
                        <span>YES PROBABILITY</span>
                        <small>{multipleLabel(yesPrice)} return if correct</small>
                      </div>
                    </div>
                    <div className="market-card-footer">
                      <div className="market-contracts" aria-label={`Contracts for ${m.title}`}>
                        <button className="contract-chip yes" onClick={(event) => { event.stopPropagation(); setSelectedSide("YES"); setSelected(m); }}>
                          <span>YES</span><strong>$R {yesPrice.toFixed(2)}</strong>
                        </button>
                        <button className="contract-chip no" onClick={(event) => { event.stopPropagation(); setSelectedSide("NO"); setSelected(m); }}>
                          <span>NO</span><strong>$R {noPrice.toFixed(2)}</strong>
                        </button>
                      </div>
                      <span className="market-volume">{dollars(m.volumeMicros)}<small> traded</small></span>
                      <button className="market-trade" onClick={(event) => { event.stopPropagation(); setSelectedSide("YES"); setSelected(m); }}>Trade</button>
                    </div>
                  </article>
                );
              })}
            </div>
            {markets.length === 0 && (
              <div className="empty">
                <h2>No markets here yet.</h2>
                <p>
                  {environmentId
                    ? "Try a different filter or create a demo run in Admin."
                    : "Seed a demo run to get started."}
                </p>
              </div>
            )}
            <div className="market-bottom">
              <span>{markets.length} markets in this view</span>
              <span>
                Market prices reflect traders’ opinions, not forecast
                confidence.
              </span>
            </div>
            <section className="explainer">
              <span className="large-star">✳</span>
              <div>
                <h2>Make your call.</h2>
                <p>
                  Start with $R 1,000. Buy YES or NO. Each winning share pays $R
                  1.
                </p>
              </div>
              <span className="explainer-note">
                Built at HackRU 2026
                <br />
                Independent student project
              </span>
            </section>
          </>
        )}
        {view === "markets" && selected && (
          <>
            <button className="back" onClick={() => setSelected(null)}>
              <ArrowLeft size={16} /> All markets
            </button>
            <div className="detail-heading">
              <div className="detail-breadcrumb">
                <span className="market-status"><i />{selected.status}</span>
                <span>{labels[selected.category]}</span>
              </div>
              <h1>{selected.title}</h1>
              <p>
                <Clock3 size={15} /> Closes {date(selected.closesAt)}
                <span>•</span> Trade while market is open
                <a href="#resolution"><FileText size={14} /> Rules & resolution</a>
              </p>
              <DemoSimulation env={env} authorized={!!me?.admin} onRefresh={() => { refreshAccount(); void request<EnvironmentView[]>("/environments").then(setEnvs); }} />
              {selected.category === "PRESENTATION_DEMO" && <PresentationPanel market={selected} admin={demoAdmin} onRefresh={refreshAccount} />}
            </div>
            <div className="detail-grid">
              <div className="detail-content">
                <div className="quote-head probability-panel">
                  <div>
                    <strong>
                      {(Number(selected.yesPrice) * 100).toFixed(1)}
                      <span>%</span>
                    </strong>
                    <p>YES probability <CircleHelp size={14} /></p>
                  </div>
                  <div className="probability-context">
                    <span>Market-implied chance, based on current trading.</span>
                    <small>NO {(100 - Number(selected.yesPrice) * 100).toFixed(1)}% · Version {selected.version}</small>
                  </div>
                </div>
                <Suspense fallback={<p>Loading chart…</p>}>
                  <MarketChart market={selected} onUpdate={refreshAccount} />
                </Suspense>
                {me && <MarketHolding market={selected} refresh={refresh} />}
                <section className="rules" id="resolution">
                  <div className="rules-heading">
                    <div>
                      <span className="eyebrow">MARKET BASICS</span>
                      <h2>Rules & resolution</h2>
                    </div>
                    <a href={selected.sourceUrl} target="_blank" rel="noreferrer">Resolution source ↗</a>
                  </div>
                  <div className="market-definitions">
                    <div>
                      <strong>What is a market?</strong>
                      <p>A prediction market is a question with two contracts. Its price is the market’s current estimate of the chance that the outcome happens.</p>
                    </div>
                    <div>
                      <strong>What does YES or NO mean?</strong>
                      <p>A YES contract pays $R 1 if the question resolves YES. A NO contract pays $R 1 if it resolves NO. Losing contracts pay $R 0.</p>
                    </div>
                    <div>
                      <strong>How does this resolve?</strong>
                      <p>{selected.resolutionRule.yesCondition}</p>
                    </div>
                  </div>
                  <AutomationDetails market={selected} />
                  <dl>
                    <dt>Observation window</dt>
                    <dd>
                      {date(selected.resolutionRule.windowStart)} —{" "}
                      {date(selected.resolutionRule.windowEnd)}
                    </dd>
                    <dt>Source</dt>
                    <dd>
                      {selected.provider} ·{" "}
                      <a
                        href={selected.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View source ↗
                      </a>
                    </dd>
                    <dt>Missing data</dt>
                    <dd>
                      Await evidence; VOID after{" "}
                      {date(selected.resolutionRule.voidAfter)}. VOID refunds
                      purchase cost.
                    </dd>
                    <dt>Finality & units</dt>
                    <dd>
                      {selected.resolutionRule.finality} ·{" "}
                      {selected.resolutionRule.units}.{" "}
                      {selected.resolutionRule.rounding}
                    </dd>
                    <dt>Rule commitment</dt>
                    <dd className="hash">
                      v{selected.ruleVersion} · {selected.ruleHash}
                    </dd>
                  </dl>
                </section>
                {["RESOLVED", "VOIDED"].includes(selected.status) && (
                  <ReceiptView
                    key={`${selected.id}:${me?.displayName ?? "public"}`}
                    marketId={selected.id}
                  />
                )}
              </div>
              <aside>
                <TradeTicket
                  market={selected}
                  env={env}
                  initialSide={selectedSide}
                  signedIn={!!me}
                  onLogin={() => setLogin(true)}
                  onTrade={() => {
                    refreshAccount();
                    setNotice(
                      "Trade confirmed. Your holdings, cash, and price have updated.",
                    );
                  }}
                />
                {selected.category === "BUS_ARRIVAL" && (
                  <Suspense fallback={<p>Loading map…</p>}>
                    <BusMap
                      marketId={selected.id}
                      routeId={String(
                        selected.context.routeId ?? "Unknown route",
                      )}
                      stopName={String(
                        selected.context.stopName ??
                          selected.context.stopId ??
                          "Target stop",
                      )}
                      deadline={String(
                        selected.context.deadline ??
                          selected.resolutionRule.windowEnd,
                      )}
                      style={config?.mapStyle ?? null}
                    />
                  </Suspense>
                )}
              </aside>
            </div>
          </>
        )}
        {view === "portfolio" && (
          <Portfolio
            environmentId={environmentId}
            balance={balance}
            refresh={refresh}
            signedIn={!!me}
            onLogin={() => setLogin(true)}
            onSelect={(m) => {
              setSelected(m);
              setView("markets");
            }}
          />
        )}
        {view === "leaderboard" && (
          <Leaderboard environmentId={environmentId} refresh={refresh} />
        )}
        {view === "admin" && me?.admin && (
          <Admin
            env={env}
            markets={markets}
            onError={setError}
            onRefresh={() => {
              refreshAccount();
              request<EnvironmentView[]>("/environments").then(setEnvs);
            }}
            onNew={(e) => {
              setEnvs((v) => [e, ...v]);
              setEnvironmentId(e.id);
              setSelected(null);
            }}
          />
        )}
      </main>
      <footer>
        <span>
          scarlet market <span>© 2026</span>
        </span>
        <span>
          Play money only · No cash-out · Not affiliated with Rutgers University
        </span>
        <span>Built at HackRU.</span>
      </footer>
      <AuthDialog
        open={login}
        config={config}
        onClose={() => setLogin(false)}
        onAuthenticated={(user) => {
          setMe(user);
          refreshAccount();
        }}
      />
      <DemoAdminDialog
        open={demoAdminLogin}
        onClose={() => setDemoAdminLogin(false)}
        onActive={() => {
          setDemoAdmin(true);
          setDemoAdminLogin(false);
          setNotice("Presentation admin mode is active for six hours.");
        }}
      />
    </div>
  );
}
function DemoAdminDialog({ open, onClose, onActive }: { open: boolean; onClose: () => void; onActive: () => void }) {
  const [password, setPassword] = useState(""), [error, setError] = useState("");
  if (!open) return null;
  return <div className="modal-backdrop" role="presentation"><section className="auth-dialog" role="dialog" aria-modal="true" aria-label="Become presentation admin">
    <button className="dialog-close" onClick={onClose}>×</button>
    <span className="eyebrow">PRESENTATION DEMO</span><h2>Become admin</h2>
    <p>Enter the presentation password to control the one-minute market.</p>
    <label>Password<input aria-label="Presentation admin password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></label>
    {error && <p className="trade-error" role="alert">{error}</p>}
    <button className="solid" onClick={() => request("/demo-admin/session", { password }).then(onActive).catch(() => setError("Incorrect password."))}>Enter admin mode</button>
  </section></div>;
}
type PresentationRun = { id: string; status: string; startedAt: string | null; deadlineAt: string | null; finishedAt: string | null; outcome: string | null; botCount: number; botTradeCount: number; botVolumeMicros: string; lastBotActivityAt: string | null };
function PresentationPanel({ market, admin, onRefresh }: { market: PublicMarket; admin: boolean; onRefresh: () => void }) {
  const [run, setRun] = useState<PresentationRun | null>(null), [nowMs, setNowMs] = useState(Date.now()), [error, setError] = useState("");
  const load = useCallback(() => request<PresentationRun>(`/presentation/${market.id}`).then(setRun).catch(() => setRun(null)), [market.id]);
  useEffect(() => { void load(); const poll = setInterval(() => { void load(); setNowMs(Date.now()); }, 500); const smooth = setInterval(() => setNowMs(Date.now()), 50); return () => { clearInterval(poll); clearInterval(smooth); }; }, [load]);
  const elapsed = run?.startedAt ? Math.min(60, Math.max(0, (nowMs - Date.parse(run.startedAt)) / 1000)) : 0;
  const remaining = Math.max(0, 60 - elapsed);
  const timer = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${(elapsed % 60).toFixed(1).padStart(4, "0")}`;
  async function control(path: string, body?: unknown) { try { await request(path, body); await load(); onRefresh(); } catch (e) { setError((e as Error).message); } }
  return <section className="presentation-panel">
    <span className="eyebrow">PRESENTATION DEMO MARKET</span>
    {run?.status === "RUNNING" ? <><strong className="presentation-timer">{timer}</strong><p>{remaining.toFixed(1)} seconds until YES</p></> : run?.outcome ? <><strong className="presentation-outcome">Outcome: {run.outcome}</strong><p>Timer settled from the server-authoritative clock.</p></> : <><strong className="presentation-ready">Timer ready</strong><p>Trading opens when the sixty-second timer begins.</p></>}
    {run && <p className="presentation-stats">{run.botTradeCount} bot trades · {dollars(run.botVolumeMicros)} simulated volume · {run.botCount} active bots</p>}
    {admin && <div className="presentation-controls">
      {run?.status === "READY" && <button className="solid" onClick={() => control(`/presentation/${market.id}/start`)}>Start presentation market</button>}
      {run?.status === "RUNNING" && <><button className="solid danger" onClick={() => control(`/presentation/${market.id}/finish`)}>Finish presentation</button><button className="outline" onClick={() => control(`/presentation/${market.id}/whale`)}>Trigger whale trade</button><button className="outline" onClick={() => control(`/presentation/${market.id}/bots`, { status: "PAUSED" })}>Pause bots</button><button className="outline" onClick={() => control(`/presentation/${market.id}/bots`, { status: "STOPPED" })}>Stop bots</button></>}
      {run?.status === "PAUSED" && <button className="solid" onClick={() => control(`/presentation/${market.id}/bots`, { status: "RUNNING" })}>Resume bots</button>}
      {run?.status === "STOPPED" && <button className="solid" onClick={() => control(`/presentation/${market.id}/bots`, { status: "RUNNING" })}>Restart bots</button>}
    </div>}
    {error && <p className="trade-error">{error}</p>}
  </section>;
}
function TradeTicket({
  market,
  env,
  initialSide,
  signedIn,
  onLogin,
  onTrade,
}: {
  market: PublicMarket;
  env?: EnvironmentView;
  initialSide: "YES" | "NO";
  signedIn: boolean;
  onLogin: () => void;
  onTrade: () => void;
}) {
  const [side, setSide] = useState<"YES" | "NO">(initialSide),
    [action, setAction] = useState<"BUY" | "SELL">("BUY"),
    [position, setPosition] = useState<Position | null>(null),
    [quantityText, setQuantityText] = useState(""),
    [quote, setQuote] = useState<{
      costMicros?: string;
      proceedsMicros?: string;
      winningPayoutMicros?: string;
      netProfitMicros?: string;
    } | null>(null),
    [quoteFor, setQuoteFor] = useState<{
      marketId: string;
      version: string;
      side: "YES" | "NO";
      action: "BUY" | "SELL";
      quantity: number;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [quoteError, setQuoteError] = useState(""),
    [tradeError, setTradeError] = useState(""),
    [pending, setPending] = useState<{
      key: string;
      max: string;
      side: string;
      action: "BUY" | "SELL";
      quantity: number;
      marketId: string;
    } | null>(null),
    quantity = quantityText ? Number(quantityText) : 0;
  const now = env?.kind === "DEMO" ? Date.parse(env.virtualNow!) : Date.now(),
    closed = market.status !== "OPEN" || now >= Date.parse(market.closesAt),
    selectedShares = BigInt(
      side === "YES" ? position?.yesShares ?? "0" : position?.noShares ?? "0",
    );
  useEffect(() => {
    setSide(initialSide);
    setTradeError("");
  }, [market.id, initialSide]);
  useEffect(() => {
    setQuote(null);
    setQuoteFor(null);
    setQuoteError("");
    setQuantityText("");
  }, [market.id]);
  useEffect(() => {
    let active = true;
    if (!signedIn) { setPosition(null); return; }
    request<{ positions: Position[] }>(`/me/positions?environmentId=${market.environmentId}`)
      .then((r) => { if (active) setPosition(r.positions.find((p) => p.market.id === market.id) ?? null); })
      .catch(() => { if (active) setPosition(null); });
    return () => { active = false; };
  }, [market.id, market.environmentId, signedIn]);
  useEffect(() => {
    setTradeError("");
    setQuoteError("");
  }, [action, side, position?.yesShares, position?.noShares]);
  useEffect(() => {
    let active = true;
    if (!closed && quantity > 0)
      request<typeof quote>(`/markets/${market.id}/quote`, {
        environmentId: market.environmentId,
        side,
        action,
        quantity,
      })
        .then((q) => {
          if (active) {
            setQuote(q);
            setQuoteFor({ marketId: market.id, version: market.version, side, action, quantity });
            setQuoteError("");
          }
        })
        .catch((e) => {
          if (active) setQuoteError(e.message);
        });
    return () => {
      active = false;
    };
  }, [market.id, market.version, side, action, quantity, closed]);
  const max = quote
    ? action === "BUY"
      ? ((BigInt(quote.costMicros ?? "0") * 102n + 99n) / 100n).toString()
      : (BigInt(quote.proceedsMicros ?? "0") * 98n / 100n).toString()
    : "0";
  const quoteIsCurrent =
    !!quote &&
    quoteFor?.marketId === market.id &&
    quoteFor.version === market.version &&
    quoteFor.side === side &&
    quoteFor.action === action &&
    quoteFor.quantity === quantity;
  async function submit() {
    if (!signedIn) {
      onLogin();
      return;
    }
    if (quantity < 1 || !quoteIsCurrent || (action === "SELL" && selectedShares === 0n)) return;
    setBusy(true);
    setTradeError("");
    const attempt =
      pending &&
      pending.side === side &&
      pending.action === action &&
      pending.quantity === quantity &&
      pending.marketId === market.id
        ? pending
        : {
            key: crypto.randomUUID(),
            max,
            side,
            action,
            quantity,
            marketId: market.id,
          };
    setPending(attempt);
    try {
      await request(`/markets/${market.id}/trades`, {
        environmentId: market.environmentId,
        side,
        quantity,
        action,
        ...(action === "BUY" ? { maxCostMicros: attempt.max } : { minProceedsMicros: attempt.max }),
        idempotencyKey: attempt.key,
      });
      setPending(null);
      setTradeError("");
      setQuantityText("");
      onTrade();
      // This refresh is informational. A transient failure after a completed
      // trade must never be reported as an order failure.
      void request<{ positions: Position[] }>(
        `/me/positions?environmentId=${market.environmentId}`,
      )
        .then((holdings) => {
          const nextPosition = holdings.positions.find((p) => p.market.id === market.id) ?? null;
          setPosition(nextPosition);
          if (action === "SELL" && BigInt(nextPosition?.yesShares ?? "0") === 0n && BigInt(nextPosition?.noShares ?? "0") === 0n)
            setAction("BUY");
        })
        .catch(() => {});
    } catch (e) {
      setTradeError(friendlyTradeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="trade-ticket">
      <div className="trade-ticket-heading">
        <div className="trade-action-tabs" role="tablist" aria-label="Order action">
          {(["BUY", "SELL"] as const).map((value) => (
            <button key={value} role="tab" aria-selected={action === value} className={action === value ? "selected" : ""} onClick={() => { setAction(value); setPending(null); setTradeError(""); }}>
              {value === "BUY" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <strong>Shares⌄</strong>
      </div>
      <div className="side-picker" aria-label="Select contract outcome">
        {(["YES", "NO"] as const).map((s) => (
          <button
            key={s}
            className={side === s ? "selected" : ""}
            disabled={
              (action === "BUY" && BigInt(s === "YES" ? position?.noShares ?? "0" : position?.yesShares ?? "0") !== 0n) ||
              (action === "SELL" && signedIn && BigInt(s === "YES" ? position?.yesShares ?? "0" : position?.noShares ?? "0") === 0n)
            }
            onClick={() => setSide(s)}
          >
            {s}{" "}
            <span>
              {(s === "YES"
                ? Number(market.yesPrice) * 100
                : 100 - Number(market.yesPrice) * 100
              ).toFixed(0)}
              ¢R
            </span>
          </button>
        ))}
      </div>
      <label className="quantity-label">
        <input
          aria-label="Number of shares"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="Shares"
          value={quantityText}
          onChange={(e) => {
            const next = e.target.value;
            if (!/^\d{0,4}$/.test(next)) return;
            setQuantityText(next && Number(next) > 1000 ? "1000" : next);
          }}
        />
      </label>
      <div className="quantity-presets">
        {[10, 25, 50, 100].map((n) => (
          <button key={n} onClick={() => setQuantityText(String(n))}>
            {n}
          </button>
        ))}
      </div>
      <div className="chance-block" aria-live="polite">
        <span>{side} chance of winning</span>
        <strong>{(side === "YES" ? Number(market.yesPrice) * 100 : 100 - Number(market.yesPrice) * 100).toFixed(0)}%</strong>
        <span>Market-implied probability</span>
      </div>
      <div className="profit-callout" aria-live="polite">
        <span>{action === "BUY" ? "Estimated profit if correct" : "Estimated sale proceeds"}</span>
        <strong>{quote ? dollars(action === "BUY" ? quote.netProfitMicros ?? "0" : quote.proceedsMicros ?? "0") : "—"}</strong>
        <small>{action === "BUY" ? `Potential payout ${quote ? dollars(quote.winningPayoutMicros ?? "0") : "—"}` : "Price updates with every completed sale."}</small>
      </div>
      <dl className="trade-summary">
        <dt>{action === "BUY" ? "Cost" : "You receive"}</dt>
        <dd>{quote && quantity > 0 ? dollars(action === "BUY" ? quote.costMicros ?? "0" : quote.proceedsMicros ?? "0", 6) : "—"}</dd>
        <dt className="hidden-summary">Average / share</dt>
        <dd className="hidden-summary">
          {quote && quantity > 0
            ? dollars(BigInt(quote.costMicros ?? "0") / BigInt(quantity))
            : "—"}
        </dd>
        <dt className="hidden-summary">
          Maximum cost <small>(2% buffer)</small>
        </dt>
        <dd>{quote ? dollars(max, 6) : "—"}</dd>
        <dt>{action === "BUY" ? "Max payout" : "Minimum receive"}</dt>
        <dd>{quote && quantity > 0 ? action === "BUY" ? dollars(quote.winningPayoutMicros ?? "0") : dollars(max, 6) : "$R 0.00"}</dd>
        <dt>Return multiple</dt>
        <dd className="return-multiple">
          {action === "BUY" && quote && quantity > 0
            ? `${(Number(quote.winningPayoutMicros) / Number(quote.costMicros)).toFixed(2)}×`
            : "—"}
        </dd>
      </dl>
      <button
        className="solid buy-button"
        disabled={busy || closed || quantity < 1 || (action === "SELL" && selectedShares === 0n) || (!quoteIsCurrent && signedIn)}
        onClick={submit}
      >
        {busy
          ? "Confirming…"
          : closed
            ? "Trading closed"
            : signedIn
              ? action === "SELL" && selectedShares === 0n
                ? "No sellable shares"
                : quantity > 0
                ? `${action === "BUY" ? "Buy" : "Sell"} ${quantity} ${side} shares`
                : "Enter number of shares"
              : `Sign in to ${action === "BUY" ? "buy" : "sell"}`}
        <ArrowRight size={16} />
      </button>
      {(quoteError || tradeError) && !closed && (
        <p className="trade-error" role="alert">
          {tradeError || friendlyTradeError(new Error(quoteError))}
        </p>
      )}
      <p className="trade-fineprint">
        Your full order moves the price. You can sell shares while this market is open.
      </p>
    </section>
  );
}
function Portfolio({
  environmentId,
  balance,
  refresh,
  signedIn,
  onLogin,
  onSelect,
}: {
  environmentId: string;
  balance: string;
  refresh: number;
  signedIn: boolean;
  onLogin: () => void;
  onSelect: (m: PublicMarket) => void;
}) {
  const [positions, setPositions] = useState<Position[]>([]),
    [trades, setTrades] = useState<
      {
        id: string;
        action?: string;
        side: string;
        quantity: string;
        costMicros: string;
        createdAt: string;
      }[]
    >([]);
  useEffect(() => {
    if (signedIn && environmentId)
      request<{ positions: Position[]; trades: typeof trades }>(
        `/me/positions?environmentId=${environmentId}`,
      ).then((r) => {
        setPositions(r.positions);
        setTrades(r.trades);
      });
  }, [environmentId, refresh, signedIn]);
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">YOUR PORTFOLIO</div>
        <h1>Make your calls count.</h1>
      </div>
      {!signedIn ? (
        <div className="empty">
          <p>Sign in to view your wallet and holdings.</p>
          <button className="solid" onClick={onLogin}>
            Sign in
          </button>
        </div>
      ) : (
        <>
          <div className="balance-banner">
            <span>Spendable cash</span>
            <strong>{dollars(balance)}</strong>
            <p>
              Buys reduce cash; sales return the current market value while a market is open.
            </p>
          </div>
          <h2 className="section-title">Your positions</h2>
          {positions.length ? (
            positions.map((p) => (
              <button
                className="position-row"
                key={p.id}
                onClick={() => onSelect(p.market)}
              >
                <div>
                  <h3>{p.market.title}</h3>
                  <p>
                    {p.yesShares} YES · {p.noShares} NO · {p.market.status}
                  </p>
                </div>
                <div>
                  {p.payout
                    ? `Paid ${dollars(p.payout.amountMicros)}`
                    : `Cost ${dollars(p.totalCostMicros)}`}
                  <ArrowUpRight size={18} />
                </div>
              </button>
            ))
          ) : (
            <div className="empty">
              Your first prediction starts in Markets.
            </div>
          )}
          <h2 className="section-title">Recent trades</h2>
          {trades.map((t) => (
            <div className="history-row" key={t.id}>
              <span>
                {t.action ?? "BUY"} {t.quantity} {t.side}
              </span>
              <span>{date(t.createdAt)}</span>
              <span>{dollars(t.costMicros)}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}
function Leaderboard({
  environmentId,
  refresh,
}: {
  environmentId: string;
  refresh: number;
}) {
  const [rows, setRows] = useState<
      {
        rank: number;
        displayName: string;
        campus: string;
        balanceMicros: string;
      }[]
    >([]),
    [campus, setCampus] = useState("");
  useEffect(() => {
    if (environmentId)
      request<typeof rows>(
        `/leaderboard?environmentId=${environmentId}${campus ? `&campus=${campus}` : ""}`,
      ).then(setRows);
  }, [environmentId, refresh, campus]);
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">CAMPUS LEADERBOARD</div>
        <h1>Who’s calling it?</h1>
        <p>
          Ranked by cash balance. Human traders only. Purchases reduce cash
          until settlement.
        </p>
      </div>
      <select
        aria-label="Campus"
        value={campus}
        onChange={(e) => setCampus(e.target.value)}
      >
        <option value="">All campuses</option>
        {campuses.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <div className="leaderboard-head">
        <span>RANK / TRADER</span>
        <span>CAMPUS</span>
        <span>CASH BALANCE</span>
      </div>
      {rows.map((r) => (
        <div className="leaderboard-row" key={r.rank}>
          <div>
            <span className="rank">{String(r.rank).padStart(2, "0")}</span>
            <strong>{r.displayName}</strong>
          </div>
          <span>{r.campus.replaceAll("_", " ")}</span>
          <strong>{dollars(r.balanceMicros)}</strong>
        </div>
      ))}
      {!rows.length && (
        <div className="empty">No human wallets in this campus yet.</div>
      )}
    </>
  );
}
function ReceiptView({ marketId }: { marketId: string }) {
  const [data, setData] = useState<Receipt | null>(null),
    [verification, setVerification] = useState<{
      status: string;
      explorerUrl?: string;
      meaning?: string;
    } | null>(null);
  useEffect(() => {
    request<Receipt>(`/markets/${marketId}/receipt`).then(setData);
  }, [marketId]);
  if (!data) return <p>Loading settlement receipt…</p>;
  function download() {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = `receipt-${marketId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="receipt">
      <div className="eyebrow">
        <Check size={15} /> SETTLEMENT RECEIPT
      </div>
      <h2>Resolved {String(data.receipt.outcome)}</h2>
      <p>
        {String(data.receipt.provenance)} ·{" "}
        {date(String(data.receipt.settledAt))}
      </p>
      <p>Observation: {JSON.stringify(data.receipt.observation)}</p>
      {data.personal && (
        <dl>
          <dt>Original cost</dt>
          <dd>{dollars(data.personal.originalCostMicros)}</dd>
          <dt>Your payout</dt>
          <dd>{dollars(data.personal.payoutMicros)}</dd>
          <dt>Net profit / loss</dt>
          <dd>{dollars(data.personal.netProfitMicros)}</dd>
        </dl>
      )}
      <p className="hash">Receipt SHA-256: {data.receiptHash}</p>
      <p>
        Devnet verification: {verification?.status ?? data.verification.status}
      </p>
      {data.verification.status !== "UNAVAILABLE" && (
        <button
          className="outline"
          onClick={() =>
            request<{ status: string; explorerUrl?: string; meaning?: string }>(
              `/markets/${marketId}/verify`,
            )
              .then(setVerification)
              .catch(() => setVerification({ status: "VERIFICATION_FAILED" }))
          }
        >
          Verify receipt
        </button>
      )}
      {verification?.explorerUrl && (
        <p>
          <a href={verification.explorerUrl} target="_blank" rel="noreferrer">
            View Devnet transaction ↗
          </a>
          <br />
          {verification.meaning}
        </p>
      )}
      <button className="outline" onClick={download}>
        Download receipt JSON <ArrowUpRight size={15} />
      </button>
    </section>
  );
}
function Admin({
  env,
  markets,
  onError,
  onRefresh,
  onNew,
}: {
  env?: EnvironmentView;
  markets: PublicMarket[];
  onError: (s: string) => void;
  onRefresh: () => void;
  onNew: (e: EnvironmentView) => void;
}) {
  const [health, setHealth] = useState<Record<string, unknown>>({}),
    [speed, setSpeed] = useState(1),
    [evidence, setEvidence] = useState(""),
    [marketId, setMarketId] = useState(""),
    [draft, setDraft] = useState("");
  useEffect(() => {
    request<Record<string, unknown>>("/admin/health").then(setHealth);
  }, [env]);
  async function control(runState: string) {
    try {
      await request(`/admin/demo/${env?.id}`, { runState, speed });
      onRefresh();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">MARKET ADMINISTRATION</div>
        <h1>Behind the market.</h1>
        <p>Worker process must be running for demo activity and settlement.</p>
      </div>
      <section className="admin-section">
        {env && <AutomationAdmin environmentId={env.id} onError={onError} />}
        <h2>Demo scenario</h2>
        <p>
          {env?.key} · {env?.runState} · Virtual time{" "}
          {env?.virtualNow ? date(env.virtualNow) : "—"}
        </p>
        <div className="admin-controls">
          <button
            className="solid"
            disabled={env?.kind !== "DEMO"}
            onClick={() => control("RUNNING")}
          >
            Start
          </button>
          <button
            className="outline"
            disabled={env?.kind !== "DEMO"}
            onClick={() => control("PAUSED")}
          >
            Pause
          </button>
          <label>
            Speed{" "}
            <select
              aria-label="Demo speed"
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              {[1, 2, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n}×
                </option>
              ))}
            </select>
          </label>
          <button
            className="outline"
            onClick={() =>
              request<EnvironmentView>("/admin/demo", { seed: 2026 })
                .then(onNew)
                .catch((e) => onError(e.message))
            }
          >
            New run
          </button>
        </div>
        <p>
          New run creates a separate environment. This two-minute scenario uses
          synthetic traders and final outcomes.
        </p>
      </section>
      <section className="admin-section">
        <h2>Worker health</h2>
        <pre>{JSON.stringify(health, null, 2)}</pre>
        <button
          className="outline"
          onClick={() =>
            request(`/admin/reconcile?environmentId=${env?.id}`)
              .then((r) => setHealth((v) => ({ ...v, reconciliation: r })))
              .catch((e) => onError(e.message))
          }
        >
          Reconcile ledger
        </button>
      </section>
      <section className="admin-section">
        <h2>Create a draft</h2>
        <p>
          Select a category template, replace its placeholders, and review its
          frozen resolution rules before opening.
        </p>
        <select
          aria-label="Draft category template"
          defaultValue=""
          onChange={(e) =>
            setDraft(
              JSON.stringify(
                marketTemplate(
                  e.target.value as (typeof categories)[number],
                  env!.id,
                ),
                null,
                2,
              ),
            )
          }
        >
          <option value="" disabled>
            Choose a template
          </option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {labels[c]}
            </option>
          ))}
        </select>
        <textarea
          aria-label="Draft market JSON"
          rows={10}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="solid"
          disabled={!draft}
          onClick={() => {
            try {
              void request("/admin/markets", JSON.parse(draft))
                .then(() => {
                  setDraft("");
                  onRefresh();
                })
                .catch((e) => onError(e.message));
            } catch {
              onError("Invalid JSON");
            }
          }}
        >
          Create funded draft
        </button>
      </section>
      <section className="admin-section">
        <h2>Lifecycle & evidence review</h2>
        <select
          aria-label="Admin market"
          value={marketId}
          onChange={(e) => setMarketId(e.target.value)}
        >
          <option value="">Select market</option>
          {markets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
        <div className="admin-controls">
          {["OPEN", "PAUSED", "CLOSED"].map((status) => (
            <button
              className="outline"
              key={status}
              disabled={!marketId}
              onClick={() =>
                request(`/admin/markets/${marketId}/status`, { status })
                  .then(onRefresh)
                  .catch((e) => onError(e.message))
              }
            >
              {status}
            </button>
          ))}
        </div>
        <label>
          Final provider evidence (JSON)
          <textarea
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="Paste the normalized provider evidence for review"
            rows={8}
          />
        </label>
        <button
          className="solid"
          disabled={!marketId || !evidence}
          onClick={() => {
            try {
              void request(
                `/admin/markets/${marketId}/settle`,
                JSON.parse(evidence),
              )
                .then(onRefresh)
                .catch((e) => onError(e.message));
            } catch {
              onError("Invalid JSON");
            }
          }}
        >
          Validate evidence & settle
        </button>
      </section>
    </>
  );
}

function MarketHolding({
  market,
  refresh,
}: {
  market: PublicMarket;
  refresh: number;
}) {
  const [position, setPosition] = useState<Position | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    request<{ positions: Position[] }>(
      `/me/positions?environmentId=${market.environmentId}`,
    )
      .then((r) => {
        if (active) {
          setPosition(
            r.positions.find((p) => p.market.id === market.id) ?? null,
          );
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [market.id, market.environmentId, refresh]);
  return (
    <section className="holding">
      <div className="holding-heading">
        <h2>Your holdings</h2>
        <span>POSITION</span>
      </div>
      {failed ? (
        <p className="holding-empty">Holdings temporarily unavailable.</p>
      ) : position ? (
        <div className="holding-details">
          <div className="holding-sides">
            <span><strong>{position.yesShares}</strong> YES</span>
            <span><strong>{position.noShares}</strong> NO</span>
          </div>
          <div className="holding-cost">
            <span>Purchase cost</span>
            <strong>{dollars(position.totalCostMicros)}</strong>
          </div>
        </div>
      ) : (
        <p className="holding-empty">You have no shares in this market yet.</p>
      )}
    </section>
  );
}
