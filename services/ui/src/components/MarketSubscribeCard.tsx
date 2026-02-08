"use client";

type Props = {
  symbol: string;
  onSymbolChange: (v: string) => void;
  onSubscribe: () => void;
  showDebug: boolean;
  gatewayBaseUrl: () => string;
  wsUrl: () => string;
};

export default function MarketSubscribeCard({
  symbol,
  onSymbolChange,
  onSubscribe,
  showDebug,
  gatewayBaseUrl,
  wsUrl,
}: Props) {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">Market</h2>

      <label className="mt-4 block text-xs font-medium text-neutral-400">Symbol</label>
      <input
        suppressHydrationWarning
        value={symbol}
        onChange={(e) => onSymbolChange(e.target.value)}
        className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-700"
        placeholder="BTC-USD"
      />

      <button
        onClick={onSubscribe}
        className="mt-3 w-full rounded-xl bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
      >
        Subscribe
      </button>

      {showDebug ? (
        <>
          <p className="mt-3 text-[11px] text-neutral-500">
            REST:{" "}
            <span className="text-neutral-300">{gatewayBaseUrl()}/tob?symbol=...</span>
          </p>

          <p className="mt-1 text-[11px] text-neutral-500">
            REST:{" "}
            <span className="text-neutral-300">
              {gatewayBaseUrl()}/depth?symbol=...&levels=10
            </span>
          </p>

          <p className="mt-1 text-[11px] text-neutral-500">
            REST:{" "}
            <span className="text-neutral-300">
              {gatewayBaseUrl()}/events?symbol=...&limit=30
            </span>
          </p>

          <p className="mt-1 text-[11px] text-neutral-500">
            WS (later): <span className="text-neutral-300">{wsUrl()}</span>
          </p>
        </>
      ) : null}
    </div>
  );
}
