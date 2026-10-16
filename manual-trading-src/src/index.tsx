import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import robot from "@/assets/robot-cursor.png";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "DigitTrade Bot — Live Digit & Binary Trading" },
      { name: "description", content: "Live tick chart with a floating digit cursor and every binary trade type." },
      { property: "og:title", content: "DigitTrade Bot — Live Digit & Binary Trading" },
      { property: "og:description", content: "Live tick chart with a floating digit cursor and every binary trade type." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Tick = { price: number; digit: number; time: number };
type Kind =
  | "matches" | "differs" | "even" | "odd" | "over" | "under"
  | "rise" | "fall" | "higher" | "lower" | "touch" | "notouch";
type Trade = {
  id: number; kind: Kind; stake: number; payout: number; ticks: number;
  entry: number; barrier?: number | undefined; digit?: number | undefined; seen: Tick[];
  status: "open" | "won" | "lost";
};

const MARKETS = [
  { id: "R_100", name: "Volatility 100" },
  { id: "R_75", name: "Volatility 75" },
  { id: "R_50", name: "Volatility 50" },
  { id: "R_25", name: "Volatility 25" },
  { id: "R_10", name: "Volatility 10" },
];

const TABS: { id: string; label: string; kinds: [Kind, Kind] }[] = [
  { id: "md", label: "Matches/Differs", kinds: ["matches", "differs"] },
  { id: "eo", label: "Even/Odd", kinds: ["even", "odd"] },
  { id: "ou", label: "Over/Under", kinds: ["over", "under"] },
  { id: "rf", label: "Rise/Fall", kinds: ["rise", "fall"] },
  { id: "hl", label: "Higher/Lower", kinds: ["higher", "lower"] },
  { id: "tn", label: "Touch/No Touch", kinds: ["touch", "notouch"] },
];

const LABEL: Record<Kind, string> = {
  matches: "Matches", differs: "Differs", even: "Even", odd: "Odd", over: "Over", under: "Under",
  rise: "Rise", fall: "Fall", higher: "Higher", lower: "Lower", touch: "Touch", notouch: "No Touch",
};

function payoutRate(k: Kind, digit: number) {
  switch (k) {
    case "matches": return 9.0;
    case "differs": return 1.06;
    case "over": return 0.95 * (10 / Math.max(1, 9 - digit));
    case "under": return 0.95 * (10 / Math.max(1, digit));
    case "touch": case "notouch": return 1.85;
    default: return 1.95;
  }
}

function settle(t: Trade): boolean {
  const last = t.seen[t.seen.length - 1]!;
  const d = last.digit;
  switch (t.kind) {
    case "matches": return d === t.digit;
    case "differs": return d !== t.digit;
    case "even": return d % 2 === 0;
    case "odd": return d % 2 === 1;
    case "over": return d > (t.digit ?? 0);
    case "under": return d < (t.digit ?? 0);
    case "rise": return last.price > t.entry;
    case "fall": return last.price < t.entry;
    case "higher": return last.price > (t.barrier ?? t.entry);
    case "lower": return last.price < (t.barrier ?? t.entry);
    case "touch": return t.seen.some((s) => (t.barrier! >= t.entry ? s.price >= t.barrier! : s.price <= t.barrier!));
    case "notouch": return !t.seen.some((s) => (t.barrier! >= t.entry ? s.price >= t.barrier! : s.price <= t.barrier!));
  }
}

function useTicks(symbol: string) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [pip, setPip] = useState(2);
  const [live, setLive] = useState(false);
  useEffect(() => {
    setTicks([]);
    const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
    ws.onopen = () => {
      setLive(true);
      ws.send(JSON.stringify({ ticks_history: symbol, count: 60, end: "latest", style: "ticks", subscribe: 1 }));
    };
    ws.onclose = () => setLive(false);
    // fallback: simulated ticks if the live feed can't connect
    let sim: ReturnType<typeof setInterval> | undefined;
    const fb = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) return;
      let price = 1000 + Math.random() * 100;
      sim = setInterval(() => {
        price += (Math.random() - 0.5) * 2;
        setTicks((prev) => [...prev.slice(-59), mk(price, Date.now(), 2)]);
      }, 1000);
    }, 4000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.msg_type === "history") {
        const ps = m.pip_size ?? 2;
        setPip(ps);
        setTicks(m.history.prices.map((p: number, i: number) => mk(p, m.history.times[i], ps)));
      } else if (m.msg_type === "tick") {
        const ps = m.tick.pip_size ?? 2;
        setPip(ps);
        setTicks((prev) => [...prev.slice(-59), mk(m.tick.quote, m.tick.epoch, ps)]);
      }
    };
    return () => { clearTimeout(fb); if (sim) clearInterval(sim); ws.close(); };
  }, [symbol]);
  return { ticks, pip, live };
}
function mk(price: number, time: number, ps: number): Tick {
  const s = price.toFixed(ps);
  return { price, time, digit: Number(s[s.length - 1]) };
}

function Index() {
  const [symbol, setSymbol] = useState("R_100");
  const { ticks, pip, live } = useTicks(symbol);
  const [tab, setTab] = useState(TABS[0]!);
  const [stake, setStake] = useState(10);
  const [dur, setDur] = useState(5);
  const [digit, setDigit] = useState(5);
  const [offset, setOffset] = useState(0.5);
  const [balance, setBalance] = useState(10000);
  const [trades, setTrades] = useState<Trade[]>([]);
  const lastTime = useRef(0);

  // settle trades on each new tick
  useEffect(() => {
    const t = ticks[ticks.length - 1];
    if (!t || t.time === lastTime.current) return;
    lastTime.current = t.time;
    setTrades((prev) =>
      prev.map((tr) => {
        if (tr.status !== "open") return tr;
        const seen = [...tr.seen, t];
        const n = { ...tr, seen };
        if (seen.length >= tr.ticks) {
          const won = settle(n);
          if (won) setBalance((b) => b + tr.payout);
          return { ...n, status: won ? "won" : "lost" };
        }
        return n;
      }),
    );
  }, [ticks]);

  const last = ticks[ticks.length - 1];
  const needsDigit = ["md", "ou"].includes(tab.id);
  const needsBarrier = ["hl", "tn"].includes(tab.id);
  const isDigitTab = ["md", "eo", "ou"].includes(tab.id);

  function buy(kind: Kind) {
    if (!last || stake <= 0 || stake > balance) return;
    const rate = payoutRate(kind, digit);
    const barrier = needsBarrier
      ? last.price + (kind === "lower" || (kind === "touch" && offset < 0) ? -Math.abs(offset) : offset)
      : undefined;
    setBalance((b) => b - stake);
    setTrades((p) => [
      { id: Date.now(), kind, stake, payout: +(stake * rate).toFixed(2), ticks: isDigitTab ? dur : Math.max(dur, 1),
        entry: last.price, barrier, digit: needsDigit ? digit : undefined, seen: [], status: "open" as const },
      ...p,
    ].slice(0, 20));
  }

  const openBarrier = trades.find((t) => t.status === "open" && t.barrier !== undefined)?.barrier;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <img src={robot} alt="" width={40} height={40} className="h-10 w-10" />
          <h1 className="text-xl font-bold tracking-tight">DigitTrade <span className="text-primary">Bot</span></h1>
        </div>
        <div className="flex items-center gap-3">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}
            className="rounded-md border border-input bg-card px-3 py-2 text-sm">
            {MARKETS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <div className="rounded-md bg-card px-4 py-2 font-mono text-sm">
            <span className="text-muted-foreground">Demo </span>${balance.toFixed(2)}
          </div>
        </div>
      </header>

      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_380px]">
        <section className="flex flex-col gap-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${live ? "bg-success" : "bg-destructive"}`} />
                {live ? "Live ticks" : ticks.length ? "Simulated ticks" : "Connecting…"}
              </span>
              <span className="font-mono text-lg">{last ? last.price.toFixed(pip) : "—"}</span>
            </div>
            <Chart ticks={ticks} barrier={openBarrier} />
          </div>
          <DigitStats ticks={ticks} selected={needsDigit ? digit : undefined} />
        </section>

        <aside className="flex flex-col gap-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="grid grid-cols-2 gap-1.5">
              {TABS.map((t) => (
                <button key={t.id} onClick={() => setTab(t)}
                  className={`rounded-md px-2 py-2 text-xs font-medium transition ${tab.id === t.id ? "bg-primary text-primary-foreground shadow-glow" : "bg-secondary text-secondary-foreground hover:bg-accent"}`}>
                  {t.label}
                </button>
              ))}
            </div>

            {needsDigit && (
              <div className="mt-4">
                <p className="mb-2 text-xs text-muted-foreground">{tab.id === "md" ? "Prediction digit" : "Barrier digit"}</p>
                <div className="grid grid-cols-5 gap-1.5">
                  {Array.from({ length: 10 }, (_, i) => (
                    <button key={i} onClick={() => setDigit(i)}
                      className={`rounded-md py-2 font-mono text-sm ${digit === i ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent"}`}>{i}</button>
                  ))}
                </div>
              </div>
            )}

            {needsBarrier && (
              <label className="mt-4 block text-xs text-muted-foreground">Barrier offset (±)
                <input type="number" step="0.1" value={offset} onChange={(e) => setOffset(Number(e.target.value))}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground" />
              </label>
            )}

            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="text-xs text-muted-foreground">Stake ($)
                <input type="number" min={1} value={stake} onChange={(e) => setStake(Number(e.target.value))}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground">Duration (ticks)
                <input type="number" min={1} max={10} value={dur} onChange={(e) => setDur(Math.min(10, Math.max(1, Number(e.target.value))))}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground" />
              </label>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              {tab.kinds.map((k, i) => (
                <button key={k} onClick={() => buy(k)} disabled={!last}
                  className={`rounded-lg px-3 py-3 text-left font-bold transition disabled:opacity-50 ${i === 0 ? "bg-success text-success-foreground" : "bg-destructive text-destructive-foreground"} hover:brightness-110`}>
                  <div>{LABEL[k]}</div>
                  <div className="font-mono text-xs font-medium opacity-80">Payout ${(stake * payoutRate(k, digit)).toFixed(2)}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-bold">Positions</h2>
            {trades.length === 0 && <p className="text-xs text-muted-foreground">No trades yet.</p>}
            <ul className="flex flex-col gap-2">
              {trades.map((t) => (
                <li key={t.id} className="flex items-center justify-between rounded-md bg-secondary px-3 py-2 text-xs">
                  <span>{LABEL[t.kind]}{t.digit !== undefined ? ` ${t.digit}` : ""} · ${t.stake}</span>
                  <span className={`font-mono font-bold ${t.status === "won" ? "text-success" : t.status === "lost" ? "text-destructive" : "text-primary"}`}>
                    {t.status === "open" ? `${t.seen.length}/${t.ticks}` : t.status === "won" ? `+$${(t.payout - t.stake).toFixed(2)}` : `-$${t.stake}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}

const W = 800, H = 340, PAD = 40;
function Chart({ ticks, barrier }: { ticks: Tick[]; barrier?: number | undefined }) {
  const pts = useMemo(() => {
    if (ticks.length < 2) return [];
    const ps = ticks.map((t) => t.price).concat(barrier !== undefined ? [barrier] : []);
    const min = Math.min(...ps), max = Math.max(...ps);
    const r = max - min || 1;
    return ticks.map((t, i) => ({
      x: PAD / 2 + (i / (ticks.length - 1)) * (W - PAD * 2.5),
      y: PAD + (1 - (t.price - min) / r) * (H - PAD * 2),
      t, min, r,
    }));
  }, [ticks, barrier]);
  if (!pts.length) return <div className="flex h-[340px] items-center justify-center text-muted-foreground">Loading chart…</div>;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  const lp = pts[pts.length - 1]!;
  const area = `${path} L${lp.x},${H} L${pts[0]!.x},${H} Z`;
  const by = barrier !== undefined ? PAD + (1 - (barrier - lp.min) / lp.r) * (H - PAD * 2) : undefined;
  const recent = pts.slice(-12, -1);

  return (
    <div className="relative w-full" style={{ aspectRatio: `${W}/${H}` }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="ga" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--primary)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#ga)" />
        <path d={path} fill="none" stroke="var(--primary)" strokeWidth="2" />
        {by !== undefined && <line x1="0" x2={W} y1={by} y2={by} stroke="var(--chart-4)" strokeDasharray="6 6" />}
        <line x1={lp.x} x2={W} y1={lp.y} y2={lp.y} stroke="var(--primary)" strokeOpacity="0.4" strokeDasharray="3 4" />
      </svg>

      {/* floating pointed digits on recent ticks */}
      {recent.map((p) => (
        <span key={p.t.time} className="pointer-events-none absolute -translate-x-1/2 -translate-y-[160%] font-mono text-[10px] font-bold text-muted-foreground transition-all duration-500"
          style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }}>
          {p.t.digit}
        </span>
      ))}

      {/* moving cursor: glowing dot + robot picture + digit bubble */}
      <div className="pointer-events-none absolute transition-all duration-500 ease-out"
        style={{ left: `${(lp.x / W) * 100}%`, top: `${(lp.y / H) * 100}%` }}>
        <span className="absolute -left-2 -top-2 h-4 w-4 rounded-full bg-primary animate-pulse-ring" />
        <span className="absolute -left-2 -top-2 h-4 w-4 rounded-full bg-primary shadow-glow" />
        <div className="absolute -top-20 right-2 flex items-center gap-1 animate-float">
          <img src={robot} alt="" width={44} height={44} className="h-11 w-11 drop-shadow-lg" />
          <div className="relative rounded-lg bg-primary px-3 py-1 font-mono text-primary-foreground shadow-glow">
            <div className="text-2xl font-bold leading-none">{lp.t.digit}</div>
            <div className="text-[9px] opacity-80">last digit</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DigitStats({ ticks, selected }: { ticks: Tick[]; selected?: number | undefined }) {
  const counts = Array.from({ length: 10 }, (_, d) => ticks.filter((t) => t.digit === d).length);
  const total = ticks.length || 1;
  const last = ticks[ticks.length - 1]?.digit;
  return (
    <div className="grid grid-cols-10 gap-2 rounded-xl border border-border bg-card p-4">
      {counts.map((c, d) => (
        <div key={d} className={`flex flex-col items-center rounded-lg py-2 transition ${last === d ? "bg-primary text-primary-foreground shadow-glow" : selected === d ? "bg-accent" : "bg-secondary"}`}>
          <span className="font-mono text-lg font-bold">{d}</span>
          <span className="text-[10px] opacity-80">{((c / total) * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  );
}
