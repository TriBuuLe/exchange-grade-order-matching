"use client";

type TopOfBook = {
  best_bid_price: string;
  best_bid_qty: string;
  best_ask_price: string;
  best_ask_qty: string;
};

type Props = {
  tob: TopOfBook | null;
  spread: number | null;
};

export default function TopOfBookCard({ tob, spread }: Props) {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">Top of Book</h2>
        <div className="text-xs text-neutral-500">
          Spread:{" "}
          <span className="text-neutral-200">
            {spread === null ? "—" : spread.toFixed(2)}
          </span>
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
          <div className="text-xs text-neutral-400">Best Bid</div>
          <div className="mt-2 text-2xl font-semibold">
            {tob ? tob.best_bid_price : "—"}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            Qty: {tob ? tob.best_bid_qty : "—"}
          </div>
        </div>

        <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
          <div className="text-xs text-neutral-400">Best Ask</div>
          <div className="mt-2 text-2xl font-semibold">
            {tob ? tob.best_ask_price : "—"}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            Qty: {tob ? tob.best_ask_qty : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}
