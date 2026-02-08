"use client";

type Props = {
  show: boolean;
  lastMsg: string;
};

export default function DebugPanel({ show, lastMsg }: Props) {
  if (!show) return null;

  return (
    <div>
      <div className="text-xs text-neutral-500">Last message</div>
      <pre className="mt-2 max-h-56 overflow-auto rounded-xl border border-neutral-800 bg-neutral-950 p-3 text-[11px] text-neutral-300">
        {lastMsg || "—"}
      </pre>
    </div>
  );
}
