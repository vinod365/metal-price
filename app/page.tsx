"use client"

import { useState, useEffect, useCallback, useRef } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_KEY = "3XZDZDF0KYBMHRDLK8NG697DLK8NG";
const BASE_URL = "https://api.metals.dev/v1";
const OZ_TO_10G = 10 / 31.1035;
const LS_KEY = "metal_price_history_v1";
const LS_REFRESH_KEY = "metal_hard_refresh_v1";
const MAX_REFRESHES = 5;
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface DayRecord {
  date: string;
  label: string;
  gold: number;
  silver: number;
}

interface StoredHistory {
  records: DayRecord[];
  lastFetchDate: string;
}

interface RefreshState {
  date: string;          // "YYYY-MM-DD" — resets on new day
  usedCount: number;     // how many hard refreshes used today (max 5)
  lastUsedAt: number;    // timestamp ms of last hard refresh
}

interface DayEntry {
  date: string;
  label: string;
  price: number;
  change: number;
}

interface ApiResponse {
  status: string;
  metals: Record<string, number>;
  error_message?: string;
  error_code?: number;
}

type MetalKey = "gold" | "silver";

interface TokenSet {
  primary: string;
  onPrimary: string;
  container: string;
  surface: string;
  chip: string;
  chipBorder: string;
  label: string;
  text: string;
}

// ─── M3 TOKENS ────────────────────────────────────────────────────────────────
const TOKEN: Record<MetalKey, TokenSet> = {
  gold: {
    primary: "#E65100",
    onPrimary: "#FFFFFF",
    container: "#FFE0B2",
    surface: "#FFF8F2",
    chip: "#FFF3E0",
    chipBorder: "#FFCC80",
    label: "#BF360C",
    text: "#1A0E00",
  },
  silver: {
    primary: "#0277BD",
    onPrimary: "#FFFFFF",
    container: "#B3E5FC",
    surface: "#F0F7FF",
    chip: "#E1F5FE",
    chipBorder: "#81D4FA",
    label: "#01579B",
    text: "#001A2C",
  },
};

const R = { sm: "10px", md: "16px", lg: "20px", xl: "28px", full: "9999px" } as const;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmtINR = (v: number): string => "₹" + Math.round(v).toLocaleString("en-IN");
const todayISO = (): string => new Date().toISOString().split("T")[0];

const dayLabel = (iso: string): string => {
  const today = todayISO();
  if (iso === today) return "Today";
  const d = new Date(); d.setDate(d.getDate() - 1);
  if (iso === d.toISOString().split("T")[0]) return "Yesterday";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short",
  });
};

const fmtCountdown = (ms: number): string => {
  if (ms <= 0) return "";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

// ─── LOCALSTORAGE ─────────────────────────────────────────────────────────────
function loadStorage(): StoredHistory {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as StoredHistory;
  } catch { /* ignore */ }
  return { records: [], lastFetchDate: "" };
}

function saveStorage(data: StoredHistory): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* ignore */ }
}

function loadRefreshState(): RefreshState {
  try {
    const raw = localStorage.getItem(LS_REFRESH_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as RefreshState;
      // Reset counter if it's a new day
      if (parsed.date !== todayISO()) {
        return { date: todayISO(), usedCount: 0, lastUsedAt: 0 };
      }
      return parsed;
    }
  } catch { /* ignore */ }
  return { date: todayISO(), usedCount: 0, lastUsedAt: 0 };
}

function saveRefreshState(s: RefreshState): void {
  try { localStorage.setItem(LS_REFRESH_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function fetchLatest(): Promise<ApiResponse> {
  const url = `${BASE_URL}/latest?api_key=${API_KEY}&currency=INR&unit=toz`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: ApiResponse = await res.json();
  if (data.status === "failure")
    throw new Error(data.error_message ?? `Error ${data.error_code}`);
  return data;
}

// ─── BUILD PER-METAL ENTRIES ──────────────────────────────────────────────────
function buildEntries(records: DayRecord[], metal: MetalKey): DayEntry[] {
  return records.map((r, i) => {
    const price = r[metal];
    const prev = i > 0 ? records[i - 1][metal] : price;
    return { date: r.date, label: r.label, price, change: i === 0 ? 0 : ((price - prev) / prev) * 100 };
  });
}

// ─── SPARKLINE ────────────────────────────────────────────────────────────────
function SparkLine({ history, color, bg }: { history: DayEntry[]; color: string; bg: string }) {
  const W = 360, H = 130;
  if (history.length < 2) return null;
  const prices = history.map(x => x.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const pad = { x: 10, y: 14 };
  const pts: [number, number][] = prices.map((p, i) => [
    pad.x + (i / (prices.length - 1)) * (W - pad.x * 2),
    pad.y + ((max - p) / (max - min || 1)) * (H - pad.y * 2),
  ]);
  const curve = pts.map(([x, y], i, a) => {
    if (i === 0) return `M ${x},${y}`;
    const [px, py] = a[i - 1]; const cx = (px + x) / 2;
    return `C ${cx},${py} ${cx},${y} ${x},${y}`;
  }).join(" ");
  const area = `${curve} L ${pts[pts.length - 1][0]},${H} L ${pts[0][0]},${H} Z`;
  const id = "g" + color.replace(/[^a-z0-9]/gi, "");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "100%", overflow: "visible", display: "block" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((t, i) => {
        const y = pad.y + t * (H - pad.y * 2);
        return <line key={i} x1={pad.x} y1={y} x2={W - pad.x} y2={y}
          stroke={color} strokeOpacity="0.1" strokeWidth="1" strokeDasharray="5 5" />;
      })}
      <path d={area} fill={`url(#${id})`} />
      <path d={curve} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y}
          r={i === pts.length - 1 ? 7 : 4}
          fill={i === pts.length - 1 ? color : bg}
          stroke={color} strokeWidth={i === pts.length - 1 ? 0 : 2.5}
          opacity={i === pts.length - 1 ? 1 : 0.7} />
      ))}
      <circle cx={last[0]} cy={last[1]} r="13"
        fill="none" stroke={color} strokeWidth="2.5" opacity="0.2"
        style={{ animation: "pulse-ring 2s ease-out infinite" }} />
    </svg>
  );
}

// ─── DAY CHIP ────────────────────────────────────────────────────────────────
function DayChip({ entry, tok, isToday, selected, onClick }: {
  entry: DayEntry; tok: TokenSet; isToday: boolean; selected: boolean; onClick: () => void;
}) {
  const isUp = entry.change >= 0;
  return (
    // paddingTop reserves room for the LIVE badge; parent must have overflow:visible
    <div style={{ position: "relative", flexShrink: 0, paddingTop: "18px" }}>

      {/* LIVE badge anchored to wrapper top — never clipped by button overflow */}
      {isToday && (
        <div style={{
          position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
          background: tok.primary, borderRadius: R.full, padding: "3px 11px",
          fontSize: "10px", fontWeight: 800, color: "#FFFFFF",
          whiteSpace: "nowrap", fontFamily: "'Google Sans',sans-serif",
          letterSpacing: "0.07em", lineHeight: "15px",
          boxShadow: `0 3px 10px ${tok.primary}60`,
          border: `1px solid white`,
          zIndex: 2,
        }}>
          ● LIVE
        </div>
      )}

      <button onClick={onClick} style={{
        background: selected ? tok.primary : "#FFFFFF",
        border: `2px solid ${selected ? tok.primary : tok.chipBorder}`,
        borderRadius: R.xl,
        padding: "12px 14px",
        cursor: "pointer",
        textAlign: "center",
        minWidth: "92px",
        display: "block",
        width: "100%",
        transform: selected ? "scale(1.06) translateY(-2px)" : "scale(1)",
        // boxShadow: selected ? `0 10px 28px ${tok.primary}40` : "0 2px 8px rgba(0,0,0,0.09)",
        transition: "all 0.3s cubic-bezier(0.34,1.56,0.64,1)",
        outline: "none",
      }}>
        {/* Date */}
        <div style={{
          fontSize: "11px", fontWeight: 600, letterSpacing: "0.03em",
          color: selected ? "rgba(255,255,255,0.80)" : tok.label,
          marginBottom: "6px", fontFamily: "'Google Sans',sans-serif",
        }}>{entry.label}</div>

        {/* Price */}
        <div style={{
          fontSize: "13px", fontWeight: 800, lineHeight: 1,
          color: selected ? "#FFFFFF" : tok.text,
          fontFamily: "'Google Sans Display',sans-serif",
          letterSpacing: "-0.3px",
        }}>{fmtINR(entry.price)}</div>

        {/* % change pill */}
        <div style={{
          display: "inline-flex", alignItems: "center", gap: "3px",
          fontFamily: "'Google Sans',sans-serif",
          fontSize: "11px", fontWeight: 700, marginTop: "8px",
          color: selected ? (isUp ? "#C8E6C9" : "#FFCDD2") : (isUp ? "#2E7D32" : "#C62828"),
          background: selected ? "rgba(255,255,255,0.18)" : (isUp ? "#E8F5E9" : "#FFEBEE"),
          borderRadius: R.full,
          padding: "3px 8px",
        }}>
          <span style={{ fontSize: "9px" }}>{isUp ? "▲" : "▼"}</span>
          <span>{Math.abs(entry.change).toFixed(2)}%</span>
        </div>
      </button>
    </div>
  );
}

// ─── SKELETON ────────────────────────────────────────────────────────────────
function Skel({ w, h = "14px", r = "8px", c }: { w: string | number; h?: string; r?: string; c: string }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: r, flexShrink: 0,
      background: `linear-gradient(90deg,${c}18,${c}38,${c}18)`,
      backgroundSize: "200% 100%", animation: "shimmer 1.5s ease-in-out infinite",
    }} />
  );
}

// ─── HARD REFRESH BUTTON ──────────────────────────────────────────────────────
function HardRefreshButton({ tok, onRefresh, refreshing }: {
  tok: TokenSet;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [rsState, setRsState] = useState<RefreshState>(loadRefreshState);
  const [now, setNow] = useState(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tick every second to update countdown
  useEffect(() => {
    timerRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const remaining = Math.max(0, rsState.lastUsedAt + COOLDOWN_MS - now);
  const inCooldown = remaining > 0;
  const exhausted = rsState.usedCount >= MAX_REFRESHES;
  const disabled = refreshing || inCooldown || exhausted;
  const usesLeft = MAX_REFRESHES - rsState.usedCount;

  const handleClick = () => {
    if (disabled) return;
    const next: RefreshState = {
      date: todayISO(),
      usedCount: rsState.usedCount + 1,
      lastUsedAt: Date.now(),
    };
    saveRefreshState(next);
    setRsState(next);
    onRefresh();
  };

  // Sync state when date changes (midnight rollover)
  useEffect(() => {
    const fresh = loadRefreshState();
    setRsState(fresh);
  }, []);

  const btnBg = disabled
    ? "#E0E0E0"
    : tok.primary;

  const btnColor = disabled ? "#9E9E9E" : tok.onPrimary;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
      <button
        onClick={handleClick}
        disabled={disabled}
        style={{
          display: "flex", alignItems: "center", gap: "6px",
          background: btnBg,
          border: "none",
          borderRadius: R.full,
          padding: "10px 20px",
          cursor: disabled ? "not-allowed" : "pointer",
          fontFamily: "'Google Sans',sans-serif",
          fontSize: "13px", fontWeight: 700,
          color: btnColor,
          boxShadow: disabled ? "none" : `0 3px 12px ${tok.primary}44`,
          transition: "all 0.25s cubic-bezier(0.34,1.56,0.64,1)",
          transform: refreshing ? "scale(0.96)" : "scale(1)",
          opacity: exhausted ? 0.5 : 1,
        }}
        onMouseDown={e => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.95)"; }}
        onMouseUp={e => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)"; }}
      >
        {/* Spinner or icon */}
        <span style={{
          display: "inline-block",
          animation: refreshing ? "spin 0.8s linear infinite" : "none",
          fontSize: "15px",
        }}>⟳</span>

        {/* Label */}
        {refreshing ? (
          <span>Refreshing…</span>
        ) : inCooldown ? (
          <span>Wait {fmtCountdown(remaining)}</span>
        ) : exhausted ? (
          <span>Limit reached</span>
        ) : (
          <span>Hard Refresh</span>
        )}

        {/* Uses left counter — always visible unless exhausted */}
        {!exhausted && (
          <span style={{
            background: disabled ? "#BDBDBD" : `${tok.onPrimary}33`,
            borderRadius: R.full,
            padding: "2px 7px",
            fontSize: "11px",
            fontWeight: 800,
            color: disabled ? "#757575" : tok.onPrimary,
            minWidth: "24px",
            textAlign: "center",
          }}>
            {usesLeft}
          </span>
        )}
      </button>

      {/* Subtext */}
      <div style={{ fontSize: "10px", color: "#BDBDBD", fontWeight: 500, fontFamily: "'Google Sans',sans-serif" }}>
        {exhausted
          ? "Resets tomorrow"
          : inCooldown
            ? `Next refresh in ${fmtCountdown(remaining)}`
            : `${usesLeft} of ${MAX_REFRESHES} refreshes left today`
        }
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [metal, setMetal] = useState<MetalKey>("gold");
  const [records, setRecords] = useState<DayRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selDay, setSelDay] = useState(0);
  const [lastUpd, setLastUpd] = useState("");

  const tok = TOKEN[metal];

  // ── Core fetch & save ─────────────────────────────────────────────────────
  const doFetch = useCallback(async (): Promise<DayRecord[] | null> => {
    const data = await fetchLatest();
    const today = todayISO();
    const gold = parseFloat((data.metals["gold"] * OZ_TO_10G).toFixed(2));
    const silver = parseFloat((data.metals["silver"] * OZ_TO_10G).toFixed(2));
    const record: DayRecord = { date: today, label: dayLabel(today), gold, silver };

    const stored = loadStorage();
    const without = stored.records.filter(r => r.date !== today);
    const updated: StoredHistory = { records: [...without, record], lastFetchDate: today };
    saveStorage(updated);
    return updated.records;
  }, []);

  // ── Init: load cache, fetch only if new day ───────────────────────────────
  const init = useCallback(async () => {
    const stored = loadStorage();
    const today = todayISO();

    if (stored.records.length > 0) {
      setRecords(stored.records);
      setSelDay(stored.records.length - 1);
      setLastUpd(stored.lastFetchDate);
      setLoading(false);
    }

    if (stored.lastFetchDate === today) return; // already fetched today

    if (stored.records.length === 0) setLoading(true);
    setError(null);

    try {
      const recs = await doFetch();
      if (recs) {
        setRecords(recs);
        setSelDay(recs.length - 1);
        setLastUpd(today);
      }
    } catch (e: unknown) {
      if (stored.records.length === 0)
        setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [doFetch]);

  // ── Hard refresh: bypass cache, force fetch ────────────────────────────────
  const hardRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const recs = await doFetch();
      if (recs) {
        setRecords(recs);
        setSelDay(recs.length - 1);
        setLastUpd(todayISO());
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setRefreshing(false);
    }
  }, [doFetch]);

  useEffect(() => { init(); }, [init]);

  const switchMetal = (m: MetalKey) => { setMetal(m); setSelDay(records.length - 1); };

  const history = buildEntries(records, metal);
  const current = history[history.length - 1]?.price ?? 0;
  const prev = history[history.length - 2]?.price ?? current;
  const dayChg = history.length > 1 ? ((current - prev) / prev) * 100 : 0;
  const totalChg = history.length > 1 ? ((current - history[0].price) / history[0].price) * 100 : 0;
  const isUp = dayChg >= 0;
  const selEntry = history[selDay] ?? null;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600;700;800&family=Google+Sans+Display:wght@400;500;600;700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { display: none; }
        html, body { height: 100%; overflow: hidden; background: #E8EAF0; font-family: 'Google Sans', sans-serif; -webkit-font-smoothing: antialiased; }
        @keyframes shimmer  { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes fadein   { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse-ring { 0% { opacity: 0.5; } 70% { opacity: 0; } 100% { opacity: 0; } }
        @keyframes price-in { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
        @keyframes slide-up { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes spin     { to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ width: "100vw", height: "100dvh", background: "#E8EAF0", display: "flex", justifyContent: "center", overflow: "hidden" }}>
        <div style={{
          width: "100%", maxWidth: "430px", height: "100dvh",
          background: "#FFFFFF", display: "flex", flexDirection: "column",
          animation: "fadein 0.45s ease forwards", position: "relative", overflow: "hidden",
        }}>

          {/* Tonal wash */}
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, height: "40dvh",
            background: `linear-gradient(160deg, ${tok.container} 0%, ${tok.surface} 65%, #fff 100%)`,
            transition: "background 0.4s ease", zIndex: 0,
          }} />

          <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
            {/* ── SCROLLABLE CONTENT ── */}
            <div style={{ flex: 1, overflowY: "auto", padding: "0 20px", width: "100%", scrollbarWidth: "none" }}>

              {/* ── HEADER ── */}
              <div style={{ paddingTop: "5dvh", paddingBottom: "2dvh" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.14em", color: tok.label, textTransform: "uppercase", marginBottom: "6px" }}>
                      {metal === "gold" ? "Gold · XAU" : "Silver · XAG"} · per 10g
                    </div>
                    <div key={metal + current} style={{
                      fontFamily: "'Google Sans Display',sans-serif",
                      fontSize: "clamp(40px, 11vw, 58px)", fontWeight: 800, lineHeight: 1,
                      color: refreshing ? tok.label : tok.primary,
                      letterSpacing: "-2px", animation: "price-in 0.35s ease",
                      transition: "color 0.3s",
                    }}>
                      {loading && records.length === 0
                        ? <Skel w="200px" h="52px" r="10px" c={tok.primary} />
                        : fmtINR(current)
                      }
                    </div>
                    <div style={{ fontSize: "12px", fontWeight: 600, color: "#9E9E9E", marginTop: "6px" }}>per 10 grams</div>
                  </div>

                  {!loading && !error && history.length > 1 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-end", paddingTop: "8px" }}>
                      <div style={{
                        display: "inline-flex", alignItems: "center", gap: "5px",
                        background: isUp ? "#E8F5E9" : "#FFEBEE",
                        borderRadius: R.full, padding: "7px 14px",
                        fontSize: "14px", fontWeight: 800,
                        color: isUp ? "#1B5E20" : "#B71C1C",
                        boxShadow: `0 2px 10px ${isUp ? "#4CAF5030" : "#F4433630"}`,
                      }}>
                        {isUp ? "↑" : "↓"} {isUp ? "+" : ""}{dayChg.toFixed(2)}%
                      </div>
                      <div style={{ fontSize: "11px", fontWeight: 600, color: "#757575", textAlign: "right" }}>
                        All time <span style={{ color: totalChg >= 0 ? "#2E7D32" : "#C62828", fontWeight: 800 }}>
                          {totalChg >= 0 ? "+" : ""}{totalChg.toFixed(2)}%
                        </span>
                      </div>
                      <div style={{ fontSize: "10px", color: "#BDBDBD", textAlign: "right" }}>
                        {records.length} day{records.length !== 1 ? "s" : ""} tracked
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── HISTORY CHIPS ── */}
              <div style={{ marginBottom: "16px", animation: "slide-up 0.4s ease 0.1s both" }}>
                {records.length > 0 && (
                  <div style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: tok.label, marginBottom: "12px" }}>
                    Price History · {records.length} day{records.length !== 1 ? "s" : ""}
                  </div>
                )}
                {/* Bleed edge-to-edge, overflow visible so LIVE badge + shadows never clip */}
                <div style={{ marginLeft: "-20px", marginRight: "-20px", paddingLeft: "20px", paddingRight: "20px", paddingTop: "18px", paddingBottom: "14px", overflow: "visible" }}>
                  <div style={{ display: "flex", gap: "10px", overflowX: "auto", paddingLeft: "4px", paddingRight: "20px", paddingTop: "2px", paddingBottom: "6px", scrollbarWidth: "none" }}>
                    {loading && records.length === 0
                      ? Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} style={{ minWidth: "88px", height: "90px", borderRadius: R.xl, flexShrink: 0, background: `linear-gradient(90deg,${tok.primary}15,${tok.primary}28,${tok.primary}15)`, backgroundSize: "200% 100%", animation: "shimmer 1.5s ease-in-out infinite" }} />
                      ))
                      : history.map((entry, i) => (
                        <DayChip key={entry.date} entry={entry} tok={tok}
                          isToday={i === history.length - 1}
                          selected={selDay === i}
                          onClick={() => setSelDay(i)} />
                      ))
                    }
                  </div>
                </div>
              </div>

              {/* ── GRAPH ── */}
              <div style={{
                background: tok.surface, borderRadius: R.xl, padding: "16px 10px 10px",
                marginBottom: "14px", border: `1.5px solid ${tok.chipBorder}`,
                boxShadow: `0 2px 16px ${tok.primary}12`,
                animation: "slide-up 0.4s ease 0.15s both", position: "relative",
              }}>
                <div style={{
                  position: "absolute", top: "12px", left: "16px",
                  fontSize: "10px", fontWeight: 700, letterSpacing: "0.1em",
                  color: tok.label, opacity: 0.6, textTransform: "uppercase",
                }}>
                  {records.length < 2 ? "Chart (needs 2+ days)" : "Price Chart"}
                </div>

                {loading && records.length === 0 ? (
                  <div style={{ height: "18dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Skel w="90%" h="100px" r="10px" c={tok.primary} />
                  </div>
                ) : error && records.length === 0 ? (
                  <div style={{ height: "18dvh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "8px" }}>
                    <div style={{ fontSize: "13px", color: "#C62828", fontWeight: 700 }}>⚠ {error}</div>
                    <button onClick={init} style={{
                      background: tok.primary, border: "none", borderRadius: R.full,
                      padding: "8px 18px", cursor: "pointer",
                      fontFamily: "'Google Sans',sans-serif", fontSize: "12px", fontWeight: 700, color: tok.onPrimary,
                    }}>Retry</button>
                  </div>
                ) : history.length < 2 ? (
                  <div style={{ height: "18dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ fontSize: "13px", color: tok.label, fontWeight: 600, textAlign: "center", opacity: 0.7, padding: "0 20px" }}>
                      Come back tomorrow —<br />chart builds as history grows
                    </div>
                  </div>
                ) : (
                  <div style={{ height: "18dvh", paddingTop: "20px" }}>
                    <SparkLine history={history} color={tok.primary} bg={tok.surface} />
                  </div>
                )}
              </div>

              {/* ── SELECTED DAY ── */}
              {selEntry && (
                <div style={{
                  background: tok.surface, borderRadius: R.lg, padding: "16px 20px",
                  border: `2px solid ${tok.chipBorder}`,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  marginBottom: "14px", boxShadow: `0 2px 12px ${tok.primary}10`,
                  animation: "slide-up 0.4s ease 0.2s both",
                }}>
                  <div>
                    <div style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.1em", color: tok.label, textTransform: "uppercase", marginBottom: "4px" }}>
                      Selected Day
                    </div>
                    <div style={{ fontFamily: "'Google Sans Display',sans-serif", fontSize: "20px", fontWeight: 700, color: tok.text }}>
                      {selEntry.label}
                    </div>
                    <div style={{ fontSize: "10px", color: "#9E9E9E", marginTop: "2px" }}>{selEntry.date}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{
                      fontFamily: "'Google Sans Display',sans-serif",
                      fontSize: "clamp(22px,5vw,28px)", fontWeight: 800,
                      color: tok.primary, letterSpacing: "-0.5px", lineHeight: 1,
                    }}>{fmtINR(selEntry.price)}</div>
                    {selDay > 0 && (
                      <div style={{ fontSize: "12px", fontWeight: 700, marginTop: "4px", color: selEntry.change >= 0 ? "#2E7D32" : "#C62828" }}>
                        {selEntry.change >= 0 ? "↑ +" : "↓ "}{selEntry.change.toFixed(3)}%
                      </div>
                    )}
                    <div style={{ fontSize: "10px", color: "#9E9E9E", marginTop: "2px" }}>per 10g</div>
                  </div>
                </div>
              )}

              {/* ── FLOW BOTTOM ── */}
              <div style={{ paddingTop: "12px", paddingBottom: "32px" }}>

                {/* Live dot + last fetched */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", marginBottom: "12px" }}>
                  <div style={{ width: "7px", height: "7px", borderRadius: "50%", background: refreshing ? "#FF9800" : "#4CAF50", boxShadow: `0 0 0 3px ${refreshing ? "#FF980022" : "#4CAF5022"}`, animation: "pulse-ring 2s ease-out infinite" }} />
                  <div style={{ fontSize: "11px", fontWeight: 600, color: "#9E9E9E" }}>
                    {refreshing ? "Fetching live price…" : `INR · per 10g${lastUpd ? ` · fetched ${dayLabel(lastUpd)}` : ""}`}
                  </div>
                </div>

                {/* Hard Refresh Button */}
                <div style={{ marginBottom: "12px", display: "flex", justifyContent: "center" }}>
                  <HardRefreshButton tok={tok} onRefresh={hardRefresh} refreshing={refreshing} />
                </div>

                {/* Error */}
                {error && (
                  <div style={{
                    background: "#FFEBEE", borderRadius: R.md, padding: "10px 14px",
                    fontSize: "12px", color: "#C62828", fontWeight: 600,
                    textAlign: "center", marginBottom: "10px",
                  }}>⚠ {error}</div>
                )}
              </div>

            </div>

            {/* ── STICKY TABS FOOTER ── */}
            <div style={{
              paddingTop: "16px",
              paddingRight: "20px",
              paddingBottom: "14px",
              paddingLeft: "20px",
              background: "rgba(255,255,255,0.85)",
              backdropFilter: "blur(14px)",
              borderTop: "1px solid rgba(0,0,0,0.06)",
              boxShadow: "0 -6px 16px rgba(0,0,0,0.04)",
              zIndex: 10,
              touchAction: "none",
              userSelect: "none",
            }}>
              <div style={{
                display: "flex", background: "#F3F4F6", borderRadius: R.full,
                padding: "6px", gap: "6px", boxShadow: "inset 0 1px 4px rgba(0,0,0,0.1)",
              }}>
                {(["gold", "silver"] as MetalKey[]).map(k => {
                  const on = metal === k;
                  const t = TOKEN[k];
                  return (
                    <button id={`metal-switcher-${k}`} key={k} onClick={() => switchMetal(k)} style={{
                      flex: 1, padding: "clamp(10px, 2.5dvh, 14px) 0",
                      background: on ? t.primary : "transparent",
                      border: "none", cursor: "pointer", borderRadius: R.full,
                      fontFamily: "'Google Sans',sans-serif",
                      fontSize: "clamp(13px,3.2vw,15px)", fontWeight: on ? 800 : 500,
                      color: on ? t.onPrimary : "#757575",
                      boxShadow: on ? `0 4px 12px ${t.primary}55` : "none",
                      transform: on ? "scale(1.02)" : "scale(1)",
                      transition: "all 0.3s cubic-bezier(0.34,1.56,0.64,1)",
                    }}>
                      {k === "gold" ? "✦  Gold" : "◇  Silver"}
                    </button>
                  );
                })}
              </div>
            </div>

          </div>
        </div>
      </div>
    </>
  );
}