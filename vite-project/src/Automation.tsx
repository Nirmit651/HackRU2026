import { useEffect, useState } from "react";
import { request, date } from "./api";
import type { PublicMarket } from "../shared/contracts";
type Status = {
  configs: {
    type: string;
    enabled: boolean;
    settings: Record<string, unknown>;
    lastRunAt: string | null;
    nextRunAt: string;
    summary: Record<string, unknown>;
  }[];
  heartbeat: string | null;
  unresolved: number;
  runs: { id: string; data: Record<string, unknown> }[];
  providerFreshness: { key: string; kind: string; updatedAt: string }[];
  jobs: {
    id: string;
    kind: string;
    status: string;
    lastError: string | null;
    runAt: string;
  }[];
};
export function AutomationAdmin({
  environmentId,
  onError,
}: {
  environmentId: string;
  onError: (s: string) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [type, setType] = useState("football"),
    [settings, setSettings] = useState("{}"),
    [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let stopped = false;
    const load = () =>
      request<Status>(`/admin/automation?environmentId=${environmentId}`)
        .then((s) => {
          if (!stopped) setStatus(s);
        })
        .catch((e) => onError(e.message));
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [environmentId, onError]);
  async function save() {
    try {
      await request("/admin/automation", {
        environmentId,
        type,
        enabled,
        settings: JSON.parse(settings),
      });
      setStatus(
        await request<Status>(
          `/admin/automation?environmentId=${environmentId}`,
        ),
      );
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <section className="admin-section">
      <h2>Market automation</h2>
      <p>
        Worker heartbeat:{" "}
        {status?.heartbeat ? date(status.heartbeat) : "Not seen"} · Unresolved:{" "}
        {status?.unresolved ?? 0}
      </p>
      <p>
        Disabling a generator stops future creation. Existing markets continue
        monitoring.
      </p>
      {status?.configs.map((c) => (
        <div key={c.type}>
          <strong>
            {c.type}: {c.enabled ? "enabled" : "disabled"}
          </strong>
          <p>
            Last: {c.lastRunAt ? date(c.lastRunAt) : "Never"} · Next:{" "}
            {date(c.nextRunAt)}
          </p>
          <pre>{JSON.stringify(c.summary, null, 2)}</pre>
          <button
            onClick={() => {
              setType(c.type);
              setSettings(JSON.stringify(c.settings, null, 2));
              setEnabled(c.enabled);
            }}
          >
            Edit settings
          </button>
        </div>
      ))}
      <label>
        Generator{" "}
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setSettings("{}");
            setEnabled(false);
          }}
        >
          {["football", "basketball", "bus"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        Enable future generation
      </label>
      <label>
        Validated settings (bus requires verified stops)
        <textarea
          value={settings}
          onChange={(e) => setSettings(e.target.value)}
          rows={6}
        />
      </label>
      <div className="admin-controls">
        <button onClick={() => void save()}>Save configuration</button>
        <button
          onClick={() =>
            void request("/admin/automation/sync", { environmentId }).catch(
              (e) => onError(e.message),
            )
          }
        >
          Sync now / retry failed jobs
        </button>
      </div>
      <details>
        <summary>Provider freshness and recent runs</summary>
        {status?.providerFreshness.map((p) => (
          <p key={p.key}>
            {p.kind} · {date(p.updatedAt)}
          </p>
        ))}
        {status?.runs.map((r) => (
          <pre key={r.id}>{JSON.stringify(r.data, null, 2)}</pre>
        ))}
      </details>
      <details>
        <summary>Scheduled and failed jobs</summary>
        {status?.jobs.map((j) => (
          <p key={j.id}>
            {j.kind} · {j.status} · {date(j.runAt)} {j.lastError}
          </p>
        ))}
      </details>
    </section>
  );
}
export function AutomationDetails({ market }: { market: PublicMarket }) {
  const [visit, setVisit] = useState<{
    state: string;
    lastObservedAt?: string;
    t0: string;
    reason?: string;
    observedDwellSeconds: number;
  } | null>(null);
  const automation = market.resolutionRule.automation;
  useEffect(() => {
    if (automation?.type !== "bus") return;
    let stopped = false;
    const load = () =>
      request<{ visit: typeof visit }>(`/markets/${market.id}/automation`)
        .then((v) => {
          if (!stopped) setVisit(v.visit);
        })
        .catch(() => {
          if (!stopped) setVisit(null);
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [market.id, automation?.type]);
  if (!automation) return null;
  return (
    <section className="context-panel">
      <h3>
        Automatically created · {automation.type} v{automation.version}
      </h3>
      <p>{market.description}</p>
      <p>
        Trading cutoff {date(market.closesAt)} · Resolution target{" "}
        {date(market.expectedResolutionAt)}
      </p>
      {visit && (
        <p>
          Observed dwell: {Math.floor(visit.observedDwellSeconds)} seconds ·{" "}
          {visit.state} · Last observation{" "}
          {visit.lastObservedAt ? date(visit.lastObservedAt) : "Unavailable"}.{" "}
          {visit.reason}
        </p>
      )}
      {automation.type === "bus" && (
        <small>
          Observed duration is informational. Backend evidence determines the
          outcome; missing data awaits recovery or VOID.
        </small>
      )}
    </section>
  );
}
