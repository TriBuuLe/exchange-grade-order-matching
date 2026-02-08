"use client";

type OrderAcceptedEvent = {
  type: "order_accepted";
  ts: number;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  accepted_seq: string;
  client_order_id?: string;
};

type FillEvent = {
  type: "fill";
  ts: number;
  symbol: string;
  price: number;
  qty: number;
  maker_seq: string;
  taker_seq: string;
};

type TradeEvent = OrderAcceptedEvent | FillEvent;

type Props = {
  events: TradeEvent[];
  fmtTime: (ts: number) => string;
};

function badgeClass(kind: "BUY" | "SELL" | "FILL") {
  if (kind === "BUY") return "bg-green-500/15 text-green-300 border-green-500/25";
  if (kind === "SELL") return "bg-red-500/15 text-red-300 border-red-500/25";
  return "bg-blue-500/15 text-blue-300 border-blue-500/25";
}

export default function TradeTapeCard({ events, fmtTime }: Props) {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-neutral-200">Trade Tape</div>
        <div className="text-xs text-neutral-500">Last 30 events</div>
      </div>

      <div className="mt-3 max-h-64 overflow-auto space-y-2">
        {events.length ? (
          events.map((ev, i) => {
            if (ev.type === "order_accepted") {
              return (
                <div
                  key={`oa-${ev.accepted_seq}-${i}`}
                  className="rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2 text-[11px]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 text-neutral-300">
                      <span className="text-neutral-500">{fmtTime(ev.ts)}</span>{" "}
                      <span className="mx-1 text-neutral-700">·</span>
                      <span
                        className={[
                          "inline-flex items-center rounded-md border px-2 py-0.5 font-semibold",
                          badgeClass(ev.side),
                        ].join(" ")}
                      >
                        {ev.side} ACCEPTED
                      </span>
                      <span className="mx-2 text-neutral-700">·</span>
                      <span className="text-neutral-400">
                        px <span className="text-neutral-100">{ev.price}</span> · qty{" "}
                        <span className="text-neutral-100">{ev.qty}</span>
                      </span>
                      {ev.client_order_id ? (
                        <>
                          <span className="mx-2 text-neutral-700">·</span>
                          <span className="truncate text-neutral-500">
                            cid <span className="text-neutral-300">{ev.client_order_id}</span>
                          </span>
                        </>
                      ) : null}
                    </div>

                    <div className="shrink-0 text-neutral-500">seq {ev.accepted_seq}</div>
                  </div>
                </div>
              );
            }

            // fill
            return (
              <div
                key={`f-${ev.maker_seq}-${ev.taker_seq}-${i}`}
                className="rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2 text-[11px]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-neutral-300">
                    <span className="text-neutral-500">{fmtTime(ev.ts)}</span>{" "}
                    <span className="mx-1 text-neutral-700">·</span>
                    <span
                      className={[
                        "inline-flex items-center rounded-md border px-2 py-0.5 font-semibold",
                        badgeClass("FILL"),
                      ].join(" ")}
                    >
                      FILL
                    </span>
                    <span className="mx-2 text-neutral-700">·</span>
                    <span className="text-neutral-400">
                      px <span className="text-neutral-100">{ev.price}</span> · qty{" "}
                      <span className="text-neutral-100">{ev.qty}</span>
                    </span>
                  </div>

                  <div className="shrink-0 text-neutral-500">
                    maker {ev.maker_seq} → taker {ev.taker_seq}
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="text-xs text-neutral-500">No events yet.</div>
        )}
      </div>
    </div>
  );
}
