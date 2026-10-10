import { useEffect, useRef, useState } from "react";
import {
  createChart,
  AreaSeries,
  HistogramSeries,
  ColorType,
  createSeriesMarkers,
  type UTCTimestamp,
} from "lightweight-charts";
import { request, supabase, date, dollars } from "./api";
import type { History, PublicEvent, PublicMarket } from "../shared/contracts";
import { EventBuffer, collapseEvents } from "../shared/recovery";
export function MarketChart({
  market,
  onUpdate,
}: {
  market: PublicMarket;
  onUpdate: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    callback = useRef(onUpdate);
  callback.current = onUpdate;
  const [range, setRange] = useState("ALL"),
    [status, setStatus] = useState("Connecting"),
    [source, setSource] = useState("Loading history"),
    [recent, setRecent] = useState<PublicEvent[]>([]),
    [panel, setPanel] = useState<"activity" | "rules" | "source">("activity");
  useEffect(() => {
    if (!host.current) return;
    let stopped = false,
      initialized = false,
      realtimeConnected = false,
      timer: ReturnType<typeof setTimeout>,
      busy = false,
      backoff = 2000;
    const buffer = new EventBuffer();
    let all: PublicEvent[] = [],
      lastTime = 0;
    const chart = createChart(host.current, {
      autoSize: true,
      height: 330,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#858187",
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "#f0eef0", visible: true },
        horzLines: { color: "#ece9eb" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: true,
        tickMarkFormatter: (t: unknown) =>
          typeof t === "number"
            ? new Intl.DateTimeFormat("en-US", {
                timeZone: "America/New_York",
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              }).format(new Date(t * 1000))
            : String(t),
      },
      localization: {
        timeFormatter: (t: unknown) =>
          typeof t === "number"
            ? date(new Date(t * 1000).toISOString())
            : String(t),
      },
    });
    const price = chart.addSeries(AreaSeries, {
      lineColor: "#d50b32",
      topColor: "rgba(213,11,50,0.20)",
      bottomColor: "rgba(213,11,50,0.015)",
      lineWidth: 2,
      priceFormat: {
        type: "custom",
        formatter: (v: number) => `${v.toFixed(0)}%`,
      },
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: 0, maxValue: 100 },
      }),
    });
    const volume = chart.addSeries(
      HistogramSeries,
      {
        color: "rgba(213,11,50,0.22)",
        priceFormat: { type: "volume" },
      },
      1,
    );
    price.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 } });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
    chart.panes()[1].setHeight(65);
    const markers = createSeriesMarkers(price, []);
    function paint(full = false) {
      const points = collapseEvents(all);
      setRecent(
        all
          .filter((e) => e.kind === "PRICE_CHANGED")
          .slice(-4),
      );
      if (full) {
        price.setData(
          points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
        );
        volume.setData(
          points.map((p) => ({
            time: p.time as UTCTimestamp,
            value: Number(p.volume) / 1e6,
          })),
        );
        chart.timeScale().fitContent();
        lastTime = points.at(-1)?.time ?? 0;
      } else
        for (const p of points.filter((p) => p.time >= lastTime)) {
          price.update({ time: p.time as UTCTimestamp, value: p.value });
          lastTime = p.time;
          volume.update({
            time: p.time as UTCTimestamp,
            value: Number(p.volume) / 1e6,
          });
        }
      markers.setMarkers(
        points
          .filter((p) => p.settled)
          .map((p) => ({
            time: p.time as UTCTimestamp,
            position: "aboveBar",
            color: "#d50b32",
            shape: "circle",
            text: `Settled ${p.settled}`,
          })),
      );
    }
    function apply() {
      const ready = buffer.drain();
      if (ready.length) {
        all.push(...ready);
        paint();
        callback.current();
      }
    }
    async function recover() {
      if (stopped || busy) return;
      busy = true;
      clearTimeout(timer);
      try {
        if (!initialized) {
          const history = await request<History>(
            `/markets/${market.id}/history?range=${range}`,
          );
          if (stopped) return;
          all = history.events;
          buffer.snapshot(history.throughVersion);
          setSource(
            history.source === "TIGER_WITH_SUPABASE_TAIL"
              ? "Tiger history + committed tail"
              : "Ledger history · analytics offline",
          );
          paint(true);
          initialized = true;
          callback.current();
          apply();
        }
        let more = true;
        for (let i = 0; more && i < 10; i++) {
          const result = await request<{
            events: PublicEvent[];
            hasMore: boolean;
          }>(`/markets/${market.id}/events?afterVersion=${buffer.version}`);
          if (stopped) return;
          result.events.forEach((e) => buffer.push(e));
          apply();
          more = result.hasMore;
        }
        backoff = 2000;
        setStatus(realtimeConnected ? "Live" : "Polling every 2 seconds");
      } catch {
        setStatus("Reconnecting…");
        backoff = Math.min(backoff * 2, 15000);
      } finally {
        busy = false;
        if (!stopped) timer = setTimeout(recover, backoff);
      }
    }
    // Subscribe before snapshot; callbacks buffer until initialization completes.
    const channel = supabase
      ?.channel(`market:${market.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "market_events",
          filter: `marketId=eq.${market.id}`,
        },
        (payload) => {
          buffer.push(payload.new as PublicEvent);
          if (initialized) {
            apply();
            if (buffer.gap) void recover();
          }
        },
      )
      .subscribe((s) => {
        realtimeConnected = s === "SUBSCRIBED";
        if (
          s === "SUBSCRIBED" ||
          s === "CHANNEL_ERROR" ||
          s === "TIMED_OUT" ||
          s === "CLOSED"
        ) {
          if (!stopped)
            setStatus(s === "SUBSCRIBED" ? "Live" : "Polling fallback");
          void recover();
        }
      });
    timer = setTimeout(recover, 250);
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (channel) void supabase?.removeChannel(channel);
      chart.remove();
    };
  }, [market.id, range]);
  return (
    <section className="chart-section">
      <div className="chart-tools">
        <span className="connection">
          <i />
          {status}
        </span>
        <div className="ranges">
          {["1H", "1D", "1W", "ALL"].map((r) => (
            <button
              key={r}
              className={r === range ? "active" : ""}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-visual">
        <div
          ref={host}
          className="chart"
          aria-label="Market-implied YES probability and traded volume"
        />
        {recent.length > 0 && <div className="chart-trade-stack" aria-live="polite">
          {recent.map((e) => <div className="chart-trade-line" key={e.id}>
            <strong>{String(e.payload.trader ?? "Anonymous")}</strong>
            <span>{String(e.payload.action ?? "BUY").toLowerCase()} {String(e.payload.quantity)} {String(e.payload.side)}</span>
          </div>)}
        </div>}
        {recent.at(-1) && <div className="chart-last-trade" aria-live="polite">
          <span>{String(recent.at(-1)?.payload.trader ?? "Anonymous")}</span>
          <strong>{String(recent.at(-1)?.payload.side)} · {dollars(recent.at(-1)!.tradeAmountMicros)}</strong>
        </div>}
      </div>
      <div className="chart-credit">
        <span>{source} · America/New_York</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          Charts by TradingView ↗
        </a>
      </div>
      <div className="market-detail-tabs" role="tablist" aria-label="Market details">
        <button role="tab" aria-selected={panel === "activity"} className={panel === "activity" ? "active" : ""} onClick={() => setPanel("activity")}>Recent activity</button>
        <button role="tab" aria-selected={panel === "rules"} className={panel === "rules" ? "active" : ""} onClick={() => setPanel("rules")}>Rules</button>
        <button role="tab" aria-selected={panel === "source"} className={panel === "source" ? "active" : ""} onClick={() => setPanel("source")}>Resolution source</button>
      </div>
      <div className="market-tab-panel">
        {panel === "activity" && (recent.length ? recent.map((e) => (
          <div className="activity-row" key={e.id}>
            <span>{String(e.payload.quantity)} {String(e.payload.side)} shares</span>
            <span>{date(e.occurredAt)}</span>
            <span>{e.payload.isSimulated ? "Simulated trade" : "Anonymous trade"}</span>
          </div>
        )) : <p>No purchases yet.</p>)}
        {panel === "rules" && <p>{market.resolutionRule.yesCondition}</p>}
        {panel === "source" && <p>Settlement uses the frozen market rule and the linked <a href={market.sourceUrl} target="_blank" rel="noreferrer">resolution source</a>. Missing qualifying evidence follows this market’s stated VOID policy.</p>}
      </div>
    </section>
  );
}
