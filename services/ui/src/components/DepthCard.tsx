"use client";

type DepthLevel = { price: string; qty: string };
type BookDepth = { bids: DepthLevel[]; asks: DepthLevel[] };

type Props = {
  depth: BookDepth | null;
};

export default function DepthCard({ depth }: Props) {
  return (
    <div className="mt-5 rounded-2xl border border-neutral-800 bg-neutral-950 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-neutral-200">Depth (L2)</div>
        <div className="text-xs text-neutral-500">Top 10 levels</div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        {/* Bids */}
        <div>
          <div className="mb-2 text-xs font-medium text-neutral-400">Bids</div>
          <div className="space-y-1">
            {(depth?.bids ?? []).map((lvl) => (
              <div
                key={`b-${lvl.price}`}
                className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs"
              >
                <span className="text-neutral-200">{lvl.price}</span>
                <span className="text-neutral-400">{lvl.qty}</span>
              </div>
            ))}
            {!depth?.bids?.length ? <div className="text-xs text-neutral-500">—</div> : null}
          </div>
        </div>

        {/* Asks */}
        <div>
          <div className="mb-2 text-xs font-medium text-neutral-400">Asks</div>
          <div className="space-y-1">
            {(depth?.asks ?? []).map((lvl) => (
              <div
                key={`a-${lvl.price}`}
                className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs"
              >
                <span className="text-neutral-200">{lvl.price}</span>
                <span className="text-neutral-400">{lvl.qty}</span>
              </div>
            ))}
            {!depth?.asks?.length ? <div className="text-xs text-neutral-500">—</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
