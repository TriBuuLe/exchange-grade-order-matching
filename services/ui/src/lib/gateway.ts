// Prefer env var (correct), fallback to same-host dev behavior
export function gatewayBaseUrl() {
  const env = process.env.NEXT_PUBLIC_GATEWAY_HTTP;
  if (env && env.trim()) return env.trim();

  if (typeof window === "undefined") return "http://localhost:8080";
  const host = window.location.hostname;
  const proto = window.location.protocol; // http: or https:
  return `${proto}//${host}:8080`;
}

// Keep wsUrl for future; UI will use this in 4G
export function wsUrl() {
  if (typeof window === "undefined") return "ws://localhost:8080/ws";
  const host = window.location.hostname;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${host}:8080/ws`;
}

export function fmtTime(ts: number) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString();
  } catch {
    return String(ts);
  }
}
