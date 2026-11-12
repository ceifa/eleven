/* The Usage view: what is left, what was spent, and what it was spent on — by
   day, by model and by thread. */

import { prefs, state, view } from "./state.js";
import { api, cachedGet } from "./api.js";
import { h, info, isPhone, pageTitle, sectionLabel } from "./ui.js";
import { fmtMoney, fmtPercent, fmtTokens, timeAgo } from "./format.js";
import { render } from "./router.js";
import { loadUsage, providersInUse } from "./models.js";

/* ---------- usage view (what the quotas were spent on) ---------- */

/** Windows the page offers. 90 days is deliberately past the default retention:
 *  asking for it is how you find out how far back the files actually go. */
const USAGE_WINDOWS = [7, 30, 90];

const tokensOf = (bucket) => bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
const promptOf = (bucket) => bucket.input + bucket.cacheRead + bucket.cacheWrite;

/** The two ways to weigh the same traffic. Tokens are what a subscription's
 *  quota counts, and nine in ten of them are cache reads; list price is what
 *  the same traffic weighs once a cached token stops counting like a fresh
 *  one. Neither is the right one, so the page asks — and the chart, the shares
 *  and the thread ranking all answer in whichever was picked. */
const METRICS = {
  tokens: { label: "Tokens", noun: "tokens", of: tokensOf, fmt: fmtTokens },
  cost: { label: "List price", noun: "at list price", of: (bucket) => bucket.cost, fmt: fmtMoney },
};

const modelLabel = (model) => model || "compaction";

function usageDays() {
  const stored = Number(prefs.get("usage.days", "30"));
  return USAGE_WINDOWS.includes(stored) ? stored : 30;
}

const usageMetric = () => (prefs.get("usage.metric", "tokens") === "cost" ? "cost" : "tokens");

/* ---------- which colour a model wears ---------- */

/** Hues the chart can tell apart; one more slot, past them, is the neutral
 *  every further model shares. The order is the validated one in style.css. */
const SERIES_HUES = 4;
const OTHER_SLOT = SERIES_HUES;

/**
 * A model keeps its colour. Ranking by spend would repaint the chart every time
 * the window changed and two models traded places, so the slot is remembered
 * per model and only handed on when its holder is no longer on the page.
 * Compaction is not a model anybody picked, and always wears the neutral.
 */
function seriesSlots(models) {
  let held = {};
  try { held = JSON.parse(prefs.get("usage.series", "{}")); } catch { /* not JSON: start over */ }
  // Anything but a plain map of model → slot is a pref someone edited by hand.
  if (!held || typeof held !== "object" || Array.isArray(held)) held = {};
  const present = new Set(models);
  const slots = new Map();
  for (const model of models) {
    if (!model) { slots.set(model, OTHER_SLOT); continue; }
    if (Number.isInteger(held[model]) && held[model] < SERIES_HUES) { slots.set(model, held[model]); continue; }
    const taken = new Set(Object.values(held));
    let slot = [...Array(SERIES_HUES).keys()].find((candidate) => !taken.has(candidate));
    if (slot === undefined) {
      // Every hue has a holder: take one from a model that is not in this window.
      const idle = Object.keys(held).find((name) => !present.has(name));
      if (idle !== undefined) { slot = held[idle]; delete held[idle]; }
    }
    if (slot === undefined) { slots.set(model, OTHER_SLOT); continue; }
    held[model] = slot;
    slots.set(model, slot);
  }
  prefs.set("usage.series", JSON.stringify(held));
  return (model) => slots.get(model) ?? OTHER_SLOT;
}

/* ---------- the view ---------- */

/** The last report read for each window and weight. The daemon builds one by
 *  walking every session file it has, and the first walk after a restart takes
 *  a second or two — so a report this page has already shown is painted from
 *  here at once, and the read that is in flight corrects it when it lands. */
const reports = new Map(); // "days:metric" → report
let reading = 0;

async function viewUsage() {
  const days = usageDays();
  const metric = usageMetric();
  const asked = `${days}:${metric}`;
  const read = ++reading;
  // /config is what the quota panel derives its provider list from, and it's
  // cached — so switching windows costs one request, not two.
  const fresh = Promise.all([
    api.get(`/usage/tokens?days=${days}${metric === "cost" ? "&by=cost" : ""}`),
    cachedGet("/config"),
  ]);
  const held = reports.get(asked);
  if (held && state.config) {
    paintUsage(held, days, metric);
    fresh.then(([report, config]) => {
      state.config = config;
      reports.set(asked, report);
      // Only while this is still the page on screen, and only if a number moved.
      const showing = read === reading && location.hash.startsWith("#/usage");
      if (showing && JSON.stringify(report) !== JSON.stringify(held)) paintUsage(report, days, metric);
    }, () => {});
    return;
  }
  const [report, config] = await fresh;
  state.config = config;
  reports.set(asked, report);
  paintUsage(report, days, metric);
}

function paintUsage(report, days, metric) {
  const slotOf = seriesSlots(report.byModel.map((entry) => entry.model));
  const empty = report.total.responses === 0;
  const span = everyDay(report);

  view.replaceChildren(
    pageTitle("Usage",
      h("div", { class: "usage-controls ml-auto" },
        // Nothing to weigh two ways when there is nothing.
        empty ? null : choice("Weigh by", Object.keys(METRICS), metric, (key) => METRICS[key].label,
          (key) => { prefs.set("usage.metric", key); void render(); }),
        choice("Window", USAGE_WINDOWS, days, (option) => `${option}d`,
          (option) => { prefs.set("usage.days", String(option)); void render(); }),
      )),
    h("div", { class: "usage-page" },
      h("div", { class: "usage-top" },
        empty
          ? h("div", { class: "usage-summary" },
              h("div", { class: "alert" }, "Nothing billed in this window. No turns ran, or their transcripts are gone."))
          : h("div", { class: "usage-summary" }, usageTiles(report, span.length), usageMakeup(report)),
        usageQuotaPanel(),
      ),
      empty ? null : usageChartSection(report, span, days, metric, slotOf),
      empty ? null : usageModelsTable(report, metric, slotOf),
      empty ? null : usageThreads(report, metric),
      usageCoverage(report, days),
    ),
  );
  void loadUsage();
}

/** A row of named values with one of them chosen. */
function choice(label, options, current, text, pick) {
  return h("div", { class: "join", role: "group", "aria-label": label }, options.map((option) =>
    h("button", {
      class: `btn btn-sm join-item${option === current ? " btn-primary" : ""}`,
      "aria-pressed": option === current ? "true" : "false",
      onclick: () => option !== current && pick(option),
    }, text(option))));
}

/* ---------- the figures ---------- */

/** The four numbers worth having before any breakdown. `span` is how many
 *  days the figures cover — today counts, the days before the files begin do
 *  not — so "a day" is a real average. */
function usageTiles(report, span) {
  const { total } = report;
  const prompt = promptOf(total);
  const hit = prompt ? total.cacheRead / prompt : 0;
  return h("div", { class: "usage-tiles" },
    usageTile("Tokens", fmtTokens(tokensOf(total)), `${fmtTokens(tokensOf(total) / span)} a day`),
    // Whether this is money or only weight depends on how the providers are
    // paid for, and eleven has no way to know. So it says what the number is
    // and lets the reader place it.
    usageTile("List price", fmtMoney(total.cost), `${fmtMoney(total.cost / span)} a day, at published rates`),
    // No colour: what is a good rate depends on the traffic, and an amber
    // figure next to an amber quota meter read as the same alarm. The line
    // under the bar below is what says when the cache is being wasted.
    usageTile("Cache hit", fmtPercent(hit), "of prompt tokens were read from cache"),
    usageTile("Responses", total.responses.toLocaleString(), `${Math.round(total.responses / span).toLocaleString()} a day`),
  );
}

function usageTile(label, value, hint) {
  return h("div", { class: "usage-tile" },
    h("div", { class: "text-xs dim-label" }, label),
    h("div", { class: "usage-tile-value" }, value),
    h("div", { class: "usage-tile-hint" }, hint),
  );
}

/**
 * What the tokens were: one bar, split into the four kinds a provider bills
 * differently, dearest first. The cache-hit figure above is this bar's biggest
 * segment said as a number; the bar is what shows the other three.
 */
function usageMakeup(report) {
  const { total } = report;
  const all = tokensOf(total) || 1;
  const parts = [
    ["Output", total.output, total.reasoning ? `${fmtTokens(total.reasoning)} reasoning` : ""],
    ["Fresh input", total.input, ""],
    ["Cache write", total.cacheWrite, ""],
    ["Cache read", total.cacheRead, ""],
  ];
  const summary = parts.map(([name, amount]) => `${name} ${fmtTokens(amount)} (${fmtShare(amount / all)})`).join(", ");
  return h("div", { class: "usage-makeup" },
    h("div", { class: "usage-makeup-bar", role: "img", "aria-label": `What the tokens were: ${summary}` },
      // Shares, not raw counts: flex-grow factors that sum to less than one
      // only hand out that fraction of the bar.
      parts.map(([, amount], index) => amount ? h("i", { class: `makeup-${index}`, style: `flex-grow:${(amount / all) * 100}` }) : null)),
    // Amounts, no percentages: the bar is the proportion, and a "cache read
    // 85%" of all tokens under a "cache hit 86%" of prompt tokens was two
    // numbers for one fact.
    h("div", { class: "usage-makeup-key" }, parts.map(([name, amount, note], index) =>
      h("span", { class: "usage-key" },
        h("i", { class: `series-swatch makeup-${index}` }),
        h("span", { class: "usage-key-name" }, name),
        h("span", { class: "usage-key-value" }, fmtTokens(amount)),
        note ? h("span", { class: "usage-key-share" }, `(${note})`) : null,
      ))),
    coldCacheNote(report),
  );
}

/** A share that doesn't round a real sliver down to nothing. */
const fmtShare = (ratio) => (ratio > 0 && ratio < 0.005 ? "<1%" : fmtPercent(ratio));

/** The one actionable line on the page: prompt tokens a warm cache would have
 *  served, and what took the warmth away. */
function coldCacheNote(report) {
  const { waste, total } = report;
  if (!waste.coldResponses) return null;
  const prompt = promptOf(total);
  const share = prompt ? waste.coldTokens / prompt : 0;
  const causes = [
    waste.idleResponses ? `${waste.idleResponses.toLocaleString()} came after more than 5 idle minutes` : null,
    waste.modelSwitchResponses ? `${waste.modelSwitchResponses.toLocaleString()} after a model switch` : null,
  ].filter(Boolean).join(", ");
  // One response can be both, and then it is counted under each cause.
  const overlap = waste.idleResponses + waste.modelSwitchResponses > waste.coldResponses ? " (some were both)" : "";
  return h("p", { class: `usage-cold${share > 0.1 ? " is-warn" : ""}` },
    h("strong", {}, `${fmtTokens(waste.coldTokens)} prompt tokens were sent with no cache to read`),
    ` — ${fmtShare(share)} of all prompt tokens. ${waste.coldResponses.toLocaleString()} responses found it cold: ${causes}${overlap}. `,
    info("A provider keeps a conversation's prompt cached for about 5 minutes, per model. A response is cold when the one before it was older than that, or ran on another model. Only those two causes are counted, so this is a floor."),
  );
}

/* ---------- per day ---------- */

const DAY_MS = 86_400_000;
/** A calendar day as the daemon files it (threads/usage.ts, localDay). */
function dayKey(ts) {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
// Days are walked as dates, not as instants: in UTC, where every day is 24
// hours long. Stepping a local Date lands an hour off across a DST change, and
// in the zones that change at midnight that hour is the next day.
const keyTime = (key) => { const [year, month, day] = key.split("-").map(Number); return Date.UTC(year, month - 1, day); };
const timeKey = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Noon local, for printing: far enough from either midnight to be the date it says. */
const dayDate = (key) => { const [year, month, day] = key.split("-").map(Number); return new Date(year, month - 1, day, 12); };
const shortDay = (key) => dayDate(key).toLocaleDateString([], { month: "short", day: "numeric" });
const longDay = (key) => dayDate(key).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

/**
 * Every day of the window, in order, with nothing in the ones nothing ran on.
 * The report only lists days that had traffic; charted as-is, a week with a
 * quiet weekend is five bars side by side and reads as five days in a row.
 * The axis starts where the files do, so asking for more days than are kept
 * doesn't spend two thirds of the chart on days that were collected.
 *
 * The daemon names the days (`sinceDay`, `oldestDay`, `today`): its calendar
 * is the one the buckets were filed under, and a browser in another timezone
 * would draw an axis a day off from the bars it has to hold.
 */
function everyDay(report) {
  const known = new Map(report.byDay.map((day) => [day.day, day]));
  const sinceDay = report.sinceDay ?? dayKey(report.since);
  const oldestDay = report.oldestDay ?? (report.oldestAt === undefined ? undefined : dayKey(report.oldestAt));
  let first = oldestDay !== undefined && oldestDay > sinceDay ? oldestDay : sinceDay;
  let last = report.today ?? dayKey(Date.now());
  // Whatever the report holds is on the axis, even if a clock disagreed.
  if (report.byDay.length) {
    if (report.byDay[0].day < first) first = report.byDay[0].day;
    if (report.byDay.at(-1).day > last) last = report.byDay.at(-1).day;
  }
  const days = [];
  // The count is a guard, not a limit anyone reaches: the daemon caps the window.
  for (let at = keyTime(first), end = keyTime(last), count = 0; at <= end && count < 4000; at += DAY_MS, count++) {
    const key = timeKey(at);
    days.push(known.get(key) ?? { day: key, total: null, byModel: {} });
  }
  return days;
}

/** The first round number at or above `value` whose half is round too — the
 *  axis has a tick there. Fine-grained enough that the tallest bar always
 *  reaches past two thirds of the plot. */
function niceCeil(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

/** A tick's label, exact to three figures. The page's own formatters round
 *  for reading ("8k" for 7,500), and a gridline has to say where it is. */
function tick(metric, value) {
  if (value === 0) return "0";
  const figure = (number) => String(Number(number.toPrecision(3)));
  if (metric === "cost") return value >= 1000 ? `$${figure(value / 1000)}k` : `$${figure(value)}`;
  return value >= 1e9 ? `${figure(value / 1e9)}B` : value >= 1e6 ? `${figure(value / 1e6)}M` : value >= 1000 ? `${figure(value / 1000)}k` : figure(value);
}

function usageChartSection(report, days, window, metric, slotOf) {
  const { of, fmt, noun } = METRICS[metric];
  const sums = days.map((day) => (day.total ? of(day.total) : 0));
  const top = niceCeil(Math.max(...sums));
  // Stacked dearest-first from the floor, in the order the table below lists.
  const order = report.byModel.map((entry) => entry.model);
  // A label under every column is unreadable past a fortnight, and past a
  // week on a phone.
  const step = Math.ceil(days.length / (isPhone() ? 5 : 10));
  const busiest = sums.indexOf(Math.max(...sums));

  // The legend is also the readout: at rest it carries the window's totals,
  // and while a day is picked it carries that day's — so every number a bar
  // stands for can be read without aiming at a segment.
  const readout = h("div", { class: "usage-readout" });
  // Asked for 90 days with 30 on disk, the chart is 30 columns: say so here,
  // not only in the footnote at the end of the page.
  const windowLabel = days.length < window ? `${days.length} of ${window} days are kept` : `${days.length} days`;
  const show = (day) => {
    const totals = day ? day.byModel : Object.fromEntries(report.byModel.map((entry) => [entry.model, entry.bucket]));
    readout.replaceChildren(
      h("span", { class: "usage-readout-when" }, day ? longDay(day.day) : windowLabel),
      day
        ? h("span", { class: "usage-readout-total" }, fmt(day.total ? of(day.total) : 0), h("span", { class: "usage-readout-noun" }, ` ${noun}`))
        // The window's total is the figure at the top of the page; what the
        // chart can add at rest is where its peak is.
        : h("span", { class: "usage-readout-total" }, h("span", { class: "usage-readout-noun" }, "busiest "), shortDay(days[busiest].day),
            h("span", { class: "usage-readout-noun" }, ` · ${fmt(sums[busiest])}`)),
      h("span", { class: "usage-readout-series" }, order.map((model) => {
        const bucket = totals[model];
        return h("span", { class: `usage-key${bucket ? "" : " is-absent"}` },
          h("i", { class: `series-swatch series-${slotOf(model)}` }),
          h("span", { class: "usage-key-name" }, modelLabel(model)),
          h("span", { class: "usage-key-value" }, bucket ? fmt(of(bucket)) : "—"),
        );
      })),
    );
  };

  // One day stays picked after a tap, where nothing hovers; a pointer or the
  // keyboard moving on to another column takes over from it.
  let pinned = -1;
  /** When a finger last picked a day by touching the plot. */
  let touchedAt = 0;
  const plot = h("div", { class: "usage-chart", role: "group", "aria-label": `${METRICS[metric].label} per day. Arrow keys move between days.` });
  const pick = (index) => {
    for (const other of plot.querySelectorAll(".is-picked")) other.classList.remove("is-picked");
    plot.classList.toggle("has-pick", index >= 0);
    columns[index]?.classList.add("is-picked");
    show(index >= 0 ? days[index] : null);
  };
  const pin = (index) => {
    pinned = index;
    columns.forEach((column, at) => column.setAttribute("aria-pressed", at === index ? "true" : "false"));
    pick(index);
  };
  const columns = days.map((day, index) => {
    const sum = sums[index];
    return h("button", {
      type: "button",
      class: "usage-col",
      // One stop in the tab order for the whole chart; the arrows do the rest.
      tabindex: index === days.length - 1 ? "0" : "-1",
      "aria-pressed": "false",
      "aria-label": `${longDay(day.day)}: ${day.total
        ? `${fmtTokens(tokensOf(day.total))} tokens, ${fmtMoney(day.total.cost)} at list price. ${order.filter((model) => day.byModel[model]).map((model) => `${modelLabel(model)} ${fmt(of(day.byModel[model]))}`).join(", ")}`
        : "nothing ran"}`,
      onpointerenter: (event) => { if (event.pointerType === "mouse") pick(index); },
      onpointerleave: (event) => { if (event.pointerType === "mouse") pick(pinned); },
      onfocus: () => pick(index),
      onblur: () => pick(pinned),
      // A touch has already picked this day on the way down; the click that
      // follows it would read as a second press and let go of it again.
      onclick: () => { if (Date.now() - touchedAt > 700) pin(pinned === index ? -1 : index); },
    },
      sum
        ? h("span", { class: "usage-stack", style: `height:${(sum / top) * 100}%` },
            order.map((model) => {
              const bucket = day.byModel[model];
              const amount = bucket ? of(bucket) : 0;
              // A share of the day, not the raw amount: a day under one dollar
              // would otherwise give flex factors under one, and a short bar.
              return amount ? h("i", { class: `series-${slotOf(model)}`, style: `flex-grow:${(amount / sum) * 100}` }) : null;
            }))
        : null,
    );
  });
  plot.addEventListener("keydown", (event) => {
    const at = columns.indexOf(document.activeElement);
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: columns.length - 1 }[event.key];
    if (at < 0 || to === undefined || !columns[to]) return;
    event.preventDefault();
    columns[at].tabIndex = -1;
    columns[to].tabIndex = 0;
    columns[to].focus();
  });
  // A finger cannot hit a column that is four pixels wide at ninety days, so
  // on touch the whole plot is the target: whichever day is under the finger
  // is the one picked, and it stays picked when the finger lifts.
  const scrub = (event) => {
    if (event.pointerType === "mouse") return;
    touchedAt = Date.now();
    const box = plot.getBoundingClientRect();
    const index = Math.min(columns.length - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * columns.length)));
    if (index !== pinned) pin(index);
  };
  plot.addEventListener("pointerdown", scrub);
  plot.addEventListener("pointermove", (event) => { if (event.buttons || event.pressure > 0) scrub(event); });
  plot.append(
    ...[1, 0.5, 0].map((at) => h("i", { class: "usage-grid", style: `bottom:${at * 100}%` })),
    ...columns,
  );
  show(null);

  return h("section", { class: "usage-section" },
    h("div", { class: "usage-section-head" }, sectionLabel("Per day")),
    readout,
    h("div", { class: "usage-plot" },
      h("div", { class: "usage-yaxis", "aria-hidden": "true", "data-widest": tick(metric, top) },
        [1, 0.5, 0].map((at) => h("span", { style: `bottom:${at * 100}%` }, tick(metric, top * at)))),
      plot,
      h("div", { class: "usage-xaxis", "aria-hidden": "true" },
        // Counted from the right: today's label is the one a reader looks for.
        days.map((day, index) => h("span", {}, (days.length - 1 - index) % step === 0 ? shortDay(day.day) : ""))),
    ),
  );
}

/* ---------- by model ---------- */

/** Ran, and cost nothing at list price: a provider with no published rate. */
const isUnpriced = ({ model, bucket }) => Boolean(model) && bucket.cost === 0 && tokensOf(bucket) > 0;

function usageModelsTable(report, metric, slotOf) {
  const { of } = METRICS[metric];
  const all = of(report.total) || 1;
  const unpriced = report.byModel.filter(isUnpriced);
  return h("section", { class: "usage-section" },
    h("div", { class: "usage-section-head" }, sectionLabel("By model")),
    h("div", { class: "usage-scroll" }, h("table", { class: "table table-sm usage-models" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Model"), h("th", {}, `Share of ${METRICS[metric].label.toLowerCase()}`),
        // The three a phone can do without: what is left fits the screen,
        // and a table cut off mid-column with no sign it scrolls reads as broken.
        h("th", { class: "num hide-mobile" }, "Prompt"), h("th", { class: "num hide-mobile" }, "Output"),
        h("th", { class: "num" }, "Cache hit"), h("th", { class: "num hide-mobile" }, "Responses"), h("th", { class: "num" }, "List price"))),
      h("tbody", {}, report.byModel.map(({ model, bucket }) => {
        const prompt = promptOf(bucket);
        const hit = prompt ? bucket.cacheRead / prompt : null;
        const share = of(bucket) / all;
        return h("tr", {},
          h("td", { class: "font-mono text-xs usage-model-name" },
            h("span", { class: `series-swatch series-${slotOf(model)}` }),
            modelLabel(model)),
          h("td", {}, h("div", { class: "usage-share" },
            h("div", { class: "usage-share-track" }, h("i", { class: `series-${slotOf(model)}`, style: `width:${share * 100}%` })),
            h("span", {}, fmtShare(share)))),
          h("td", { class: "num hide-mobile" }, fmtTokens(prompt)),
          h("td", { class: "num hide-mobile" }, fmtTokens(bucket.output)),
          // Only a poor rate is marked: a column where every cell is coloured
          // says nothing, and the figure at the top already grades the whole.
          h("td", { class: `num${hit !== null && hit < 0.7 ? " is-bad" : ""}` }, hit === null ? "—" : fmtPercent(hit)),
          h("td", { class: "num hide-mobile" }, bucket.responses.toLocaleString()),
          // "$0" would say it was free. It was not priced.
          isUnpriced({ model, bucket }) ? h("td", { class: "num usage-unpriced" }, "no list price") : h("td", { class: "num" }, fmtMoney(bucket.cost)),
        );
      })),
    )),
    unpriced.length
      ? h("div", { class: "usage-footnote" },
          `${unpriced.map((entry) => modelLabel(entry.model)).join(", ")} ${unpriced.length === 1 ? "has" : "have"} no published rate: ${unpriced.length === 1 ? "its" : "their"} tokens are counted, and weigh nothing in list price.`)
      : null,
    report.compaction.responses
      ? h("div", { class: "usage-footnote" },
          `compaction: ${report.compaction.responses} summarization calls the threads paid to keep going.`)
      : null,
  );
}

/* ---------- by thread ---------- */

/**
 * The threads that weigh the most, heaviest first, each with a bar against the
 * heaviest. Rows rather than a table: what is being read is a ranking, and a
 * title is the one cell here that needs room to be read.
 */
function usageThreads(report, metric) {
  if (!report.byThread.length) return null;
  const { of, fmt, label } = METRICS[metric];
  const other = METRICS[metric === "cost" ? "tokens" : "cost"];
  const rows = [...report.byThread].sort((a, b) => of(b) - of(a));
  const max = of(rows[0]) || 1;
  const listed = rows.reduce((sum, thread) => sum + of(thread), 0);
  const all = of(report.total) || 1;
  const more = report.threads > rows.length;
  return h("section", { class: "usage-section" },
    h("div", { class: "usage-section-head" },
      sectionLabel("Heaviest threads"),
      h("span", { class: "usage-section-note" },
        more
          ? `the ${rows.length} heaviest of ${report.threads.toLocaleString()} by ${label.toLowerCase()}, ${fmtShare(listed / all)} of the window`
          : `${rows.length} thread${rows.length === 1 ? "" : "s"}, by ${label.toLowerCase()}`)),
    h("ol", { class: "usage-threads" }, rows.map((thread) =>
      h("li", { class: "usage-thread" },
        h("a", { class: "usage-thread-name", href: `#/threads/${thread.id}`, title: thread.title ?? thread.conversation ?? thread.id },
          h("span", { class: "usage-thread-title" }, thread.title ?? thread.conversation ?? thread.id.slice(0, 8)),
          h("span", { class: "usage-thread-meta" },
            // "last on": a thread that failed over ran on more than one, and
            // the figures beside this are all of them together.
            [thread.workspace, `last on ${modelLabel(thread.lastModel)}`, thread.lastAt ? `${timeAgo(thread.lastAt)} ago` : null].filter(Boolean).join(" · "))),
        h("div", { class: "usage-thread-bar", "aria-hidden": "true" }, h("i", { style: `width:${(of(thread) / max) * 100}%` })),
        h("span", { class: "usage-thread-value" }, fmt(of(thread))),
        h("span", { class: "usage-thread-other" }, other.fmt(other.of(thread))),
      ))),
  );
}

/* ---------- what is left ---------- */

/** The same quota meters the Models page carries, at the top of this one so a
 *  single screen answers both halves of the question: what is left, and what
 *  was spent.
 *
 *  Only the first half is optional — a provider billed per use has no window
 *  to run out of — so every row here is provisional until /usage answers, and
 *  loadUsage drops the ones (and the panel) that turn out to have nothing. */
function usageQuotaPanel() {
  const providers = providersInUse();
  if (!providers.length) return null;
  return h("aside", { class: "usage-quota", "data-usage-strip": true },
    sectionLabel("Quota left"),
    ...providers.map((provider) =>
      h("div", { class: "usage-quota-provider", "data-usage-optional": true },
        h("div", { class: "flex items-center gap-2" },
          h("span", { class: "font-mono text-sm" }, provider),
          h("span", { class: "text-xs opacity-50", "data-usage-plan": provider }),
        ),
        h("div", { class: "flex flex-col gap-1.5", "data-usage-provider": provider },
          h("div", { class: "text-xs opacity-40" }, "checking…")),
      )),
  );
}

/** Where the data actually begins, which is not where the window does: gc
 *  deletes session files on a retention timer, and what it took with it cannot
 *  be counted. Saying so beats a chart that quietly flattens. */
function usageCoverage(report, days) {
  const parts = [`${report.threads.toLocaleString()} thread${report.threads === 1 ? "" : "s"}`, `${days} days asked for`];
  if (report.oldestAt !== undefined) {
    const oldest = new Date(report.oldestAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    parts.push(report.oldestAt > report.since
      ? `transcripts on disk begin ${oldest}; older ones were deleted when their retention ran out`
      : `transcripts on disk begin ${oldest}`);
  }
  return h("div", { class: "usage-footnote", title: `window starts ${new Date(report.since).toLocaleString()}` },
    parts.join(" · "));
}

export { viewUsage };
