"use client";

type Props = {
  title: string;
  subtitle: string;
  status: "disconnected" | "connecting" | "connected";
  showDebug: boolean;
  onToggleDebug: () => void;
};

export default function MarketHeader({
  title,
  subtitle,
  status,
  showDebug,
  onToggleDebug,
}: Props) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onToggleDebug}
          className="rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          {showDebug ? "Hide debug" : "Show debug"}
        </button>

        <div className="rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={[
                "h-2 w-2 rounded-full",
                status === "connected"
                  ? "bg-green-500"
                  : status === "connecting"
                  ? "bg-yellow-500"
                  : "bg-red-500",
              ].join(" ")}
            />
            <span className="text-neutral-300">{status}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
