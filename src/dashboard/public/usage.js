/* The Usage view: what the tokens were spent on, by day, model and thread. */

import { prefs, state, view } from "./state.js";
import { api, cachedGet } from "./api.js";
import { h, info, pageTitle, sectionLabel } from "./ui.js";
import { fmtMoney, fmtPercent, fmtTokens } from "./format.js";
import { render } from "./router.js";
import { loadUsage, providersInUse } from "./models.js";

/* ---------- usage view (what the quotas were spent on) ---------- */

/** Windows the page offers. 90 days is deliberately past the default retention:
 *  asking for it is how you find out how far back the files actually go. */
const USAGE_WINDOWS = [7, 30, 90];
/** How many models the chart gives a colour of their own. */
const SERIES_COLORS = 5;

const tokensOf = (bucket) => bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
const promptOf = (bucket) => bucket.input + bucket.cacheRead + bucket.cacheWrite;

const modelLabel = (model) => model || "compaction";

function usageDays() {
  const stored = Number(prefs.get("usage.days", "30"));
  return USAGE_WINDOWS.includes(stored) ? stored : 30;
}

async function viewUsage() {
  const days = usageDays();
  // /config is what the quota strip derives its provider list from, and it's
  // cached — so switching windows costs one request, not two.
  const [report, config] = await Promise.all([api.get(`/usage/tokens?days=${days}`), cachedGet("/config")]);
  state.config = config;

  // Chart and legend agree on colour by sharing one ordering: byModel arrives
  // sorted by spend, so the biggest series is always series-0.
  const series = report.byModel.map((entry) => entry.model);

  view.replaceChildren(
    pageTitle("Usage",
      h("div", { class: "join ml-auto" }, USAGE_WINDOWS.map((option) =>
        h("button", {
          class: `btn btn-sm join-item${option === days ? " btn-primary" : ""}`,
          onclick: () => { prefs.set("usage.days", String(option)); void render(); },
        }, `${option}d`)))),
    // No blurb under the title: the tiles name themselves, and the line at the
    // bottom of the page says where the numbers come from.
    h("div", { class: "flex flex-col gap-5" },
      report.total.responses === 0
        ? h("div", { class: "alert" }, "Nothing billed in this window. No turns ran, or their transcripts are gone.")
        : h("div", { class: "flex flex-col gap-5" },
            usageTiles(report),
            coldCacheNote(report),
            usageChartSection(report, series),
            usageModelsTable(report, series),
            usageThreadsTable(report),
          ),
      usageQuotaSection(),
      usageCoverage(report, days),
    ),
  );
  void loadUsage();
}

/** The four numbers worth having before any breakdown. */
function usageTiles(report) {
  const { total } = report;
  const prompt = promptOf(total);
  const hit = prompt ? total.cacheRead / prompt : 0;
  return h("div", { class: "usage-tiles" },
    usageTile("Prompt", fmtTokens(prompt),
      `${fmtTokens(total.input)} fresh · ${fmtTokens(total.cacheRead)} cached · ${fmtTokens(total.cacheWrite)} written`),
    usageTile("Output", fmtTokens(total.output),
      `${fmtTokens(total.reasoning)} reasoning · ${total.responses.toLocaleString()} responses`),
    usageTile("Cache hit", fmtPercent(hit), "prompt tokens served from cache",
      hit >= 0.9 ? "good" : hit >= 0.7 ? "warn" : "bad"),
    // Whether this is money or only weight depends on how the providers are
    // paid for, and eleven has no way to know. So it says what the number is
    // and lets the reader place it.
    usageTile("List price", fmtMoney(total.cost), "at each provider's published rates"),
  );
}

function usageTile(label, value, hint, tone) {
  return h("div", { class: `usage-tile${tone ? ` is-${tone}` : ""}` },
    h("div", { class: "text-xs dim-label" }, label),
    h("div", { class: "usage-tile-value" }, value),
    h("div", { class: "text-xs opacity-40" }, hint),
  );
}

/** The one actionable line on the page: prompt tokens a warm cache would have
 *  served, and what took the warmth away. */
function coldCacheNote(report) {
  const { waste, total } = report;
  if (!waste.coldResponses) return null;
  const prompt = promptOf(total);
  const share = prompt ? waste.coldTokens / prompt : 0;
  const causes = [
    waste.idleResponses ? `${waste.idleResponses} idle over 5 min` : null,
    waste.modelSwitchResponses ? `${waste.modelSwitchResponses} on a model switch` : null,
  ].filter(Boolean).join(", ");
  return h("div", { class: "text-sm opacity-60" },
    h("span", { class: share > 0.1 ? "text-warning" : "" }, `${fmtTokens(waste.coldTokens)} cold prompt tokens`),
    ` (${fmtPercent(share)}) over ${waste.coldResponses} responses: ${causes}. `,
    info("Cold means the response before it was over 5 minutes old, past the cache TTL, or ran on another model. Only those two causes are counted, so this is a floor."),
  );
}

function usageChartSection(report, series) {
  const max = Math.max(...report.byDay.map((day) => tokensOf(day.total)), 1);
  // A label under every column is unreadable past a fortnight.
  const step = Math.ceil(report.byDay.length / 12);
  return h("div", { class: "flex flex-col gap-2" },
    sectionLabel("Per day"),
    h("div", { class: "usage-chart" }, report.byDay.map((day, index) =>
      h("div", { class: "usage-col" },
        h("div", {
          class: "usage-stack",
          style: `height:${(tokensOf(day.total) / max) * 100}%`,
          title: `${day.day} · ${fmtTokens(tokensOf(day.total))} tokens · ${fmtMoney(day.total.cost)}`,
        }, series.map((model, rank) => {
          const bucket = day.byModel[model];
          if (!bucket) return null;
          return h("i", {
            class: `series-${Math.min(rank, SERIES_COLORS - 1)}`,
            style: `height:${(tokensOf(bucket) / tokensOf(day.total)) * 100}%`,
          });
        })),
        h("div", { class: "usage-xlabel" }, index % step === 0 ? day.day.slice(5) : ""),
      ))),
  );
}

function usageModelsTable(report, series) {
  return h("div", { class: "flex flex-col gap-2" },
    sectionLabel("By model"),
    h("div", { class: "usage-scroll" }, h("table", { class: "table table-sm" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Model"), h("th", {}, "Responses"), h("th", {}, "Prompt"),
        h("th", {}, "Output"), h("th", {}, "Cache hit"), h("th", {}, "List price"))),
      h("tbody", {}, report.byModel.map(({ model, bucket }, rank) => {
        const prompt = promptOf(bucket);
        return h("tr", {},
          h("td", { class: "font-mono text-xs" },
            h("span", { class: `series-swatch series-${Math.min(series.indexOf(model), SERIES_COLORS - 1)}` }),
            modelLabel(model)),
          h("td", {}, bucket.responses.toLocaleString()),
          h("td", {}, fmtTokens(prompt)),
          h("td", {}, fmtTokens(bucket.output)),
          h("td", {}, prompt ? fmtPercent(bucket.cacheRead / prompt) : "—"),
          h("td", {}, fmtMoney(bucket.cost)),
        );
      })),
    )),
    report.compaction.responses
      ? h("div", { class: "text-xs opacity-40" },
          `compaction: ${report.compaction.responses} summarization calls the threads paid to keep going.`)
      : null,
  );
}

function usageThreadsTable(report) {
  if (!report.byThread.length) return null;
  return h("div", { class: "flex flex-col gap-2" },
    sectionLabel("Where it went"),
    h("div", { class: "usage-scroll" }, h("table", { class: "table table-sm" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Thread"), h("th", {}, "Workspace"), h("th", {}, "Tokens"), h("th", {}, "List price"), h("th", {}, "Last model"))),
      h("tbody", {}, report.byThread.map((thread) =>
        h("tr", {},
          h("td", {}, h("a", {
            class: "link link-hover usage-thread",
            href: `#/threads/${thread.id}`,
            title: thread.title ?? thread.conversation ?? thread.id,
          }, thread.title ?? thread.conversation ?? thread.id.slice(0, 8))),
          h("td", { class: "font-mono text-xs opacity-60" }, thread.workspace),
          h("td", {}, fmtTokens(tokensOf(thread))),
          h("td", {}, fmtMoney(thread.cost)),
          h("td", { class: "font-mono text-xs opacity-60" }, modelLabel(thread.lastModel)),
        ))),
    )),
  );
}

/** The same quota meters the Models page carries, mirrored here so one screen
 *  answers both halves of the question: what was spent, and what is left.
 *
 *  Only the second half is optional — a provider billed per use has no window
 *  to run out of — so every row here is provisional until /usage answers, and
 *  loadUsage drops the ones (and the strip) that turn out to have nothing. */
function usageQuotaSection() {
  const providers = providersInUse();
  if (!providers.length) return null;
  return h("div", { class: "flex flex-col gap-2", "data-usage-strip": true },
    sectionLabel("Quota left"),
    ...providers.map((provider) =>
      h("div", { class: "flex flex-col gap-1.5 py-1", "data-usage-optional": true },
        h("div", { class: "flex items-center gap-2" },
          h("span", { class: "font-mono text-sm" }, provider),
          h("span", { class: "text-xs opacity-50", "data-usage-plan": provider }),
        ),
        h("div", { class: "flex flex-col gap-1.5", "data-usage-provider": provider },
          h("div", { class: "text-xs opacity-40" }, "checking usage…")),
      )),
  );
}

/** Where the data actually begins, which is not where the window does: gc
 *  deletes session files on a retention timer, and what it took with it cannot
 *  be counted. Saying so beats a chart that quietly flattens. */
function usageCoverage(report, days) {
  const parts = [`${report.threads} thread${report.threads === 1 ? "" : "s"}`, `${days} days`];
  if (report.oldestAt !== undefined) {
    const oldest = new Date(report.oldestAt).toLocaleDateString();
    parts.push(report.oldestAt > report.since ? `on disk since ${oldest}, older collected` : `on disk since ${oldest}`);
  }
  return h("div", { class: "text-xs opacity-40", title: `window starts ${new Date(report.since).toLocaleString()}` },
    parts.join(" · "));
}

export { viewUsage };
