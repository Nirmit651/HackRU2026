import { useState } from "react";
import type { EnvironmentView } from "../shared/contracts";
import { request } from "./api";

export function DemoSimulation({ env, authorized, onRefresh }: { env?: EnvironmentView; authorized: boolean; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!env || env.kind !== "DEMO" || !authorized) return null;
  const demo = env;
  const running = demo.runState === "RUNNING";
  async function control() {
    setBusy(true); setMessage("");
    try {
      await request(`/admin/demo/${demo.id}`, { runState: running ? "PAUSED" : "RUNNING", speed: 10 });
      setMessage(running ? "Simulation paused." : "Simulating at 10× speed.");
      onRefresh();
    } catch { setMessage("Worker unavailable"); }
    finally { setBusy(false); }
  }
  return <div className="demo-simulation">
    <button className="simulation-button" onClick={() => void control()} disabled={busy}>{busy ? "Simulating…" : running ? "Pause simulation" : "Simulate market"}</button>
    <span role="status" aria-live="polite">{message || (running ? "Simulation running" : "Simulation ready")}</span>
  </div>;
}
