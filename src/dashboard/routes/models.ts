import { runtimeTools } from "../../config.ts";
import { collectProviderUsage, usageLogins } from "../../provider-usage.ts";
import { buildUsageReport, localDay, startOfLocalDay } from "../../threads/usage.ts";
import { displayTitle } from "../../threads/title.ts";
import { modelRuntime } from "../../agent/pi.ts";
import { CLAUDE_CODE_PROVIDER } from "../../agent/claude-code.ts";
import { claudeEmail, signedInAccounts } from "../../accounts.ts";
import type { DashboardContext } from "../context.ts";
import { ApiError } from "../http.ts";
import type { Route } from "../router.ts";

// Token accounting bounds. The default window is a month because that is also
// roughly how long session files survive gc; the ceiling is only there so a
// hand-typed query can't ask for a window arithmetic would overflow.
const DEFAULT_USAGE_DAYS = 30;
const MAX_USAGE_DAYS = 3650;
const USAGE_THREAD_LIMIT = 20;

/** What can run a turn, who is signed in to it, and what it has cost. */
export function modelRoutes({ config, gateway, identityOf }: DashboardContext): Route[] {
  function authStatus(provider: string) {
    try {
      const status = modelRuntime.getProviderAuthStatus(provider);
      return { configured: status.configured, source: status.source, label: status.label };
    } catch {
      return { configured: false };
    }
  }

  return [
    {
      method: "GET",
      pattern: "/models",
      async handler({ send }) {
        // The full catalog, with everything the model picker needs to filter:
        // which runtime serves the ref (and thus which tools exist there),
        // whether it can reason, and how much context it carries.
        const available = await modelRuntime.getAvailable();
        return send(200, available
          .map((m) => ({
            ref: `${m.provider}/${m.id}`,
            name: m.name,
            provider: m.provider,
            reasoning: m.reasoning,
            contextWindow: m.contextWindow,
            tools: runtimeTools(m.provider),
          }))
          .sort((a, b) => a.ref.localeCompare(b.ref)));
      },
    },
    // Subscription quotas for every provider the sequences reference. Network
    // calls behind it are slow — the UI fetches this after first paint.
    {
      method: "GET",
      pattern: "/usage",
      async handler({ send }) {
        return send(200, await collectProviderUsage(usageLogins(config.configuredLogins())));
      },
    },
    // The other half of the question the endpoint above answers: not what a
    // provider has left, but what was spent getting there — which is the only
    // half that exists at all for a provider billed per use.
    //
    // Read off the session transcripts: the first report walks the whole
    // history, and every one after it only what was appended since (usage.ts),
    // so there is no index on disk to keep honest. Only what is still there can
    // be counted — gc deletes session files on a retention timer, and
    // `oldestAt` says where the data actually begins.
    {
      method: "GET",
      pattern: "/usage/tokens",
      async handler({ url, send }) {
        const raw = url.searchParams.get("days");
        const days = raw === null ? DEFAULT_USAGE_DAYS : Number(raw);
        if (!Number.isInteger(days) || days <= 0 || days > MAX_USAGE_DAYS) throw new ApiError(400, "days must be an integer between 1 and 3650");
        // Which threads make the list depends on what "heaviest" means to the
        // page asking: a thread that is all cache reads tops the token count
        // and barely registers on price, and the cut below would drop the
        // dearest threads from a list ranked by tokens.
        const by = url.searchParams.get("by") ?? "tokens";
        if (by !== "tokens" && by !== "cost") throw new ApiError(400, "by must be tokens or cost");
        const report = await buildUsageReport(
          gateway.threads.list().map((thread) => ({
            id: thread.id,
            sessionFile: thread.sessionFile,
            title: displayTitle(thread.title),
            workspace: thread.workspace,
            conversation: identityOf(thread.sessionKey).name,
          })),
          startOfLocalDay(Date.now(), days - 1),
        );
        // The long tail of threads is dozens of rows nobody reads; the total
        // above already counts them.
        const ranked = by === "cost" ? [...report.byThread].sort((a, b) => b.cost - a.cost) : report.byThread;
        // The days are named here, on the daemon's calendar: the page draws
        // an axis the buckets have to line up with, and a browser in another
        // timezone would name the same instants a day off.
        return send(200, {
          ...report,
          days,
          sinceDay: localDay(report.since),
          oldestDay: report.oldestAt === undefined ? undefined : localDay(report.oldestAt),
          today: localDay(Date.now()),
          byThread: ranked.slice(0, USAGE_THREAD_LIMIT),
        });
      },
    },
    {
      method: "GET",
      pattern: "/providers",
      async handler({ send }) {
        const configured = new Set(
          config.resolved.models.map((entry) => entry.model.split("/")[0]).filter(Boolean),
        );
        for (const model of await modelRuntime.getAvailable()) configured.add(model.provider);
        // The other logins a model entry can pick, by account name.
        const accounts = signedInAccounts();
        for (const login of accounts) configured.add(login.provider);
        return send(
          200,
          [...configured].sort().map((provider) => ({
            provider,
            ...authStatus(provider),
            ...(provider === CLAUDE_CODE_PROVIDER && { machineLabel: claudeEmail() }),
            accounts: accounts.filter((login) => login.provider === provider).map(({ account, label }) => ({ name: account, label })),
          })),
        );
      },
    },
  ];
}
