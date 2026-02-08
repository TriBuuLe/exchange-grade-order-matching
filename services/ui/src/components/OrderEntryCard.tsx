"use client";

type Fill = {
  maker_seq: string;
  taker_seq: string;
  price: string;
  qty: string;
};

type Props = {
  side: "BUY" | "SELL";
  setSide: (v: "BUY" | "SELL") => void;

  qty: string;
  setQty: (v: string) => void;

  price: string;
  setPrice: (v: string) => void;

  submitting: boolean;
  onSubmit: () => void;

  submitResult: string;

  lastAcceptedSeq: string | null;
  lastFills: Fill[];

  showDebug: boolean;
  gatewayBaseUrl: () => string;
};

export default function OrderEntryCard({
  side,
  setSide,
  qty,
  setQty,
  price,
  setPrice,
  submitting,
  onSubmit,
  submitResult,
  lastAcceptedSeq,
  lastFills,
  showDebug,
  gatewayBaseUrl,
}: Props) {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">Order Entry</h2>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-neutral-400">Side</label>
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}
            className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-700"
          >
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-neutral-400">Qty</label>
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-700"
            placeholder="1"
            inputMode="numeric"
          />
        </div>

        <div className="col-span-2">
          <label className="text-xs font-medium text-neutral-400">Price</label>
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-700"
            placeholder="102"
            inputMode="numeric"
          />
        </div>
      </div>

      <button
        onClick={onSubmit}
        disabled={submitting}
        className="mt-4 w-full rounded-xl bg-blue-500 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-400 disabled:opacity-60"
      >
        {submitting ? "Submitting..." : "Submit Order"}
      </button>

      {submitResult ? (
        <pre className="mt-3 max-h-40 overflow-auto rounded-xl border border-neutral-800 bg-neutral-950 p-3 text-[11px] text-neutral-200">
          {submitResult}
        </pre>
      ) : null}

      {/* Last fills panel */}
      <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-950 p-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-neutral-200">Last Fills</div>
          <div className="text-[11px] text-neutral-500">
            {lastAcceptedSeq ? `taker_seq=${lastAcceptedSeq}` : "—"}
          </div>
        </div>

        <div className="mt-2 space-y-1">
          {lastFills.length ? (
            lastFills.map((f, i) => (
              <div
                key={`${f.maker_seq}-${f.taker_seq}-${f.price}-${i}`}
                className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[11px]"
              >
                <div className="text-neutral-300">
                  px <span className="text-neutral-100">{f.price}</span> · qty{" "}
                  <span className="text-neutral-100">{f.qty}</span>
                </div>
                <div className="text-neutral-500">
                  maker {f.maker_seq} → taker {f.taker_seq}
                </div>
              </div>
            ))
          ) : (
            <div className="text-[11px] text-neutral-500">
              No fills (order rested or last submit failed).
            </div>
          )}
        </div>
      </div>

      {showDebug ? (
        <p className="mt-3 text-[11px] text-neutral-500">
          REST: <span className="text-neutral-300">{gatewayBaseUrl()}/orders</span>
        </p>
      ) : null}
    </div>
  );
}
