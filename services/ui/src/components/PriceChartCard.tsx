"use client";

import { useEffect, useMemo, useState } from "react";

type Candle = {
  ts: number; // ms bucket start
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type CandlesResponse = {
  ok: boolean;
  symbol: string;
  interval: string;
  interval_ms: number;
  count: number;
  candles: Candle[];
};

type Props = {
  symbol: string;
  gatewayBaseUrl: () => string;
};

const WINDOW = 120; // how many candles to display (sliding window)

function fmt(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

export default function PriceChartCard({ symbol, gatewayBaseUrl }: Props) {
  const [interval, setInterval] = useState<string>("1s");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let alive = true;

    async function load() {
      const sym = symbol.trim();
      if (!sym) return;

      try {
        const url = `${gatewayBaseUrl()}/candles?symbol=${encodeURIComponent(
          sym
        )}&interval=${encodeURIComponent(interval)}&limit=${WINDOW}`;

        const res = await fetch(url, { cache: "no-store" });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);

        const data = JSON.parse(text) as CandlesResponse;
        if (!data.ok || !Array.isArray(data.candles)) {
          throw new Error("bad candles response");
        }

        if (!alive) return;

        const incoming = data.candles.slice(-WINDOW);

        // ✅ REAL sliding window:
        // - append only NEW candles by ts (so it "moves forward")
        // - if same ts (current bucket updated), replace last candle in-place
        setCandles((prev) => {
          if (!incoming.length) return prev;
          if (!prev.length) return incoming.slice(-WINDOW);

          const lastPrevTs = prev[prev.length - 1].ts;
          const newer = incoming.filter((c) => c.ts > lastPrevTs);

          if (newer.length) {
            return [...prev, ...newer].slice(-WINDOW);
          }

          const lastIncoming = incoming[incoming.length - 1];
          if (lastIncoming.ts === lastPrevTs) {
            const copy = prev.slice();
            copy[copy.length - 1] = lastIncoming;
            return copy.slice(-WINDOW);
          }

          // backend window moved backwards (restart / reset) -> hard reset
          return incoming.slice(-WINDOW);
        });

        setError("");
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message ?? String(e));
      }
    }

    load();
    const t = window.setInterval(load, 1000);

    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [symbol, interval, gatewayBaseUrl]);

  const stats = useMemo(() => {
    if (!candles.length) return null;

    const min = Math.min(...candles.map((c) => c.low));
    const max = Math.max(...candles.map((c) => c.high));
    const span = max - min || 1;

    const last = candles[candles.length - 1];
    const prev = candles.length >= 2 ? candles[candles.length - 2] : null;
    const delta = prev ? last.close - prev.close : 0;

    return { min, max, span, last, delta };
  }, [candles]);

  const svg = useMemo(() => {
    const w = 900;
    const h = 320;
    const padX = 18;
    const padY = 14;

    const plotW = w - padX * 2;
    const plotH = h - padY * 2;

    if (!stats || candles.length === 0) {
      return { w, h, padX, padY, plotW, plotH, bodies: [], grid: [] as any[] };
    }

    const yOf = (price: number) => {
      return padY + (1 - (price - stats.min) / stats.span) * plotH;
    };

    const grid = Array.from({ length: 5 }, (_, i) => {
      const t = i / 4;
      const y = padY + t * plotH;
      const price = stats.max - t * stats.span;
      return { y, price };
    });

    const n = candles.length;
    const xStep = plotW / Math.max(1, n);
    const candleW = Math.max(3, Math.min(9, xStep * 0.7));
    const wickW = 1.5;

    const bodies = candles.map((c, i) => {
      const cx = padX + xStep * i + xStep / 2;

      const yHigh = yOf(c.high);
      const yLow = yOf(c.low);
      const yOpen = yOf(c.open);
      const yClose = yOf(c.close);

      const up = c.close >= c.open;

      const bodyTopRaw = Math.min(yOpen, yClose);
      const bodyBotRaw = Math.max(yOpen, yClose);

      const isDoji = Math.abs(c.close - c.open) < 1e-9;
      const bodyH = isDoji ? 6 : Math.max(2, bodyBotRaw - bodyTopRaw);
      const bodyTop = isDoji ? bodyTopRaw - bodyH / 2 : bodyTopRaw;

      return {
        i,
        cx,
        up,
        wick: { x1: cx, y1: yHigh, x2: cx, y2: yLow, w: wickW },
        body: {
          x: cx - candleW / 2,
          y: bodyTop,
          w: candleW,
          h: bodyH,
        },
      };
    });

    return { w, h, padX, padY, plotW, plotH, bodies, grid };
  }, [candles, stats]);

  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-neutral-200">Price</div>
          <div className="mt-1 text-xs text-neutral-500">
            {symbol.trim() ? (
              <>
                {symbol.trim()} · interval {interval} · {candles.length} candles
              </>
            ) : (
              "Enter a symbol and subscribe"
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-neutral-500">Interval</label>
          <select
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            className="rounded-lg border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          >
            <option value="1s">1s</option>
            <option value="5s">5s</option>
            <option value="10s">10s</option>
            <option value="30s">30s</option>
            <option value="1m">1m</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="1h">1h</option>
          </select>
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-red-900/40 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      <div className="mt-3 rounded-xl border border-neutral-800 bg-neutral-900 p-3">
        <svg viewBox={`0 0 ${svg.w} ${svg.h}`} className="h-[340px] w-full">
          <rect x="0" y="0" width={svg.w} height={svg.h} fill="transparent" />

          {svg.grid.map((g, idx) => (
            <g key={idx}>
              <line
                x1={svg.padX}
                y1={g.y}
                x2={svg.w - svg.padX}
                y2={g.y}
                stroke="rgba(255,255,255,0.06)"
                strokeWidth="1"
              />
              <text
                x={svg.w - 6}
                y={g.y + 4}
                textAnchor="end"
                fontSize="11"
                fill="rgba(255,255,255,0.35)"
              >
                {Math.round(g.price)}
              </text>
            </g>
          ))}

          {svg.bodies.map((b) => {
            const up = b.up;
            const wickColor = up
              ? "rgba(34,197,94,0.9)"
              : "rgba(239,68,68,0.9)";
            const bodyFill = up
              ? "rgba(34,197,94,0.45)"
              : "rgba(239,68,68,0.45)";
            const bodyStroke = up
              ? "rgba(34,197,94,0.95)"
              : "rgba(239,68,68,0.95)";

            return (
              <g key={b.i}>
                <line
                  x1={b.wick.x1}
                  y1={b.wick.y1}
                  x2={b.wick.x2}
                  y2={b.wick.y2}
                  stroke={wickColor}
                  strokeWidth={b.wick.w}
                  strokeLinecap="round"
                />
                <rect
                  x={b.body.x}
                  y={b.body.y}
                  width={b.body.w}
                  height={b.body.h}
                  fill={bodyFill}
                  stroke={bodyStroke}
                  strokeWidth="1"
                  rx="1.5"
                />
              </g>
            );
          })}
        </svg>

        <div className="mt-2 flex items-center justify-between text-xs">
          <div className="text-neutral-500">
            {candles.length ? (
              <>
                {fmt(candles[0].ts)} → {fmt(candles[candles.length - 1].ts)}
              </>
            ) : (
              "No candles yet"
            )}
          </div>

          <div className="text-neutral-300">
            {stats ? (
              <>
                last{" "}
                <span className="text-neutral-100">
                  {Math.round(stats.last.close)}
                </span>{" "}
                <span className="text-neutral-500">
                  ({stats.delta >= 0 ? "+" : ""}
                  {Math.round(stats.delta)})
                </span>
              </>
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
