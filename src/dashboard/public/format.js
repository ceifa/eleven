/* How times, sizes and token counts read on screen. */

import { startOfDay } from "./live-turn.js";

const timeAgo = (ts) => {
  const s = Math.max(1, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const DAY_MS = 86_400_000;

/* toLocaleTimeString builds a formatter, uses it once and throws it away — and
   a transcript asks for a time per bubble, hundreds at a go. These are the same
   formatters, built once. */
const CLOCK = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
const CLOCK_SECONDS = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const DAY = new Intl.DateTimeFormat([], { day: "numeric", month: "short" });
const DAY_AND_YEAR = new Intl.DateTimeFormat([], { day: "numeric", month: "short", year: "numeric" });

/** "Today" / "Yesterday" / a date — the label on a transcript's day separator. */
function dayLabel(ts) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return (sameYear ? DAY : DAY_AND_YEAR).format(date);
}

const clock = (ts) => CLOCK.format(ts);

const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const fmtTime = (ts) => CLOCK_SECONDS.format(ts);

/** Token counts run to ten digits here, and nobody reads ten digits. */
function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** Cents under a hundred dollars, none above — and always the same number of
 *  decimals at a given size, so a column of prices lines up: "$24.00" over
 *  "$24.34", not "$24" over "$24.34". */
const fmtMoney = (n) => `$${n.toLocaleString("en-US", n < 100 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 })}`;
const fmtPercent = (ratio) => `${Math.round(ratio * 100)}%`;

export { timeAgo, dayLabel, clock, fmtBytes, fmtTime, fmtTokens, fmtMoney, fmtPercent };
