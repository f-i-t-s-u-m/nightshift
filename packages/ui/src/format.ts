const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");

export const formatTokens = (n: number): string => (Math.abs(n) < 1000 ? whole.format(n) : compact.format(n));

export const formatUsd = (n: number): string => {
  const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(n);
};

export const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
};

export const formatElapsed = (from: string | null | undefined, now: number): string => {
  if (!from) return "—";
  const t = Date.parse(from);
  return Number.isNaN(t) ? "—" : formatDuration(now - t);
};

export const formatTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
};

export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export const formatPercent = (ratio: number): string => `${Math.round(Math.max(0, ratio) * 100)}%`;

export const humanize = (value: string): string => value.replace(/_/g, " ");

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export const formatRelative = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return relative.format(Math.round(s / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return relative.format(Math.round(s / 86400), "day");
  if (abs < 86400 * 365) return relative.format(Math.round(s / (86400 * 30)), "month");
  return relative.format(Math.round(s / (86400 * 365)), "year");
};
