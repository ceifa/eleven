/* The Models view — the global sequence and the providers behind it — and the
   two pieces the other config pages borrow from it: the sequence editor
   (Workspaces) and the providers' quota meters (Usage). */

import { state, view } from "./state.js";
import { api, cachedGet } from "./api.js";
import { h, info, labeled, pageTitle, sectionLabel } from "./ui.js";
import { queueSave } from "./config.js";

/* ---------- models view (the sequence) ---------- */

const fmtContext = (tokens) =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}k`;

const ALL_TOOLS = () => state.overview?.tools ?? ["read", "bash", "edit", "write"];

const REASONING_LEVELS = () => state.overview?.reasoningLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh"];

function modelsDatalist() {
  return h("datalist", { id: "models-list" }, (state.catalog ?? []).map((m) => h("option", { value: m.ref })));
}

/** One usage window as a thin meter: how much of the quota is already burned. */
function usageMeter(window) {
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const level = used >= 90 ? "crit" : used >= 65 ? "warn" : "";
  const reset = window.resetAt ? ` · resets ${timeUntil(window.resetAt)}` : "";
  return h("div", { class: "flex items-center gap-2 text-xs" },
    h("span", { class: "usage-label" }, window.label),
    window.unlimited
      ? h("span", { class: "opacity-60" }, "unlimited")
      : h("div", { class: `meter ${level}` }, h("i", { style: `width:${used}%` })),
    window.unlimited ? null : h("span", { class: "opacity-60", style: "white-space:nowrap" }, `${Math.round(100 - used)}% left${reset}`),
  );
}

function timeUntil(ts) {
  const minutes = Math.max(0, Math.ceil((ts - Date.now()) / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  if (days) return `in ${days}d ${hours}h`;
  if (hours) return `in ${hours}h ${minutes % 60}m`;
  return `in ${minutes}m`;
}

/** Fill each provider card's usage slot once /usage answers. The server hits
 * each provider's quota API for it, so reuse recent reports across the
 * re-renders every structural edit triggers. */
const USAGE_TTL_MS = 60_000;
let usageCache = { at: 0, reports: null };
async function loadUsage() {
  if (!usageCache.reports || Date.now() - usageCache.at > USAGE_TTL_MS) {
    usageCache = { at: Date.now(), reports: await api.get("/usage").catch(() => []) };
  }
  const { reports } = usageCache;
  for (const slot of document.querySelectorAll("[data-usage-provider]")) {
    // One report per login: the machine's own, then each named account.
    const logins = reports.filter((r) => r.provider === slot.dataset.usageProvider);
    slot.replaceChildren();
    if (!logins.length) continue;
    if (logins.every((r) => r.unsupported)) {
      // A provider billed per use has no quota to report, and saying so is only
      // worth the room where the provider itself is the subject. Anywhere the
      // slot is marked optional (the Usage page's strip), the row just goes.
      const optional = slot.closest("[data-usage-optional]");
      if (optional) optional.remove();
      else slot.append(h("div", { class: "text-xs opacity-40" }, "this provider doesn't report subscription usage"));
      continue;
    }
    for (const report of logins) {
      if (report.unsupported) continue;
      if (logins.length > 1) slot.append(h("div", { class: "text-xs dim-label mt-1" }, loginLabel(report.provider, report.account)));
      if (report.error) {
        slot.append(h("div", { class: "text-xs text-error opacity-60" }, `usage unavailable — ${report.error}`));
        continue;
      }
      const { usage } = report;
      for (const window of usage.windows) slot.append(usageMeter(window));
      if (usage.credits !== undefined) slot.append(h("div", { class: "text-xs opacity-60" }, `${usage.credits.toLocaleString()} credits left`));
      for (const fact of usage.facts ?? []) slot.append(h("div", { class: "text-xs opacity-60" }, `${fact.label}: ${fact.value}`));
      // The plan lands in the card header, next to the provider's name.
      const plan = document.querySelector(`[data-usage-plan="${report.provider}"]`);
      if (plan && usage.plan && !report.account) plan.textContent = `${usage.provider} · ${usage.plan}`;
    }
  }
  // A strip whose every row turned out to have no quota is a heading over
  // nothing: it goes too.
  for (const section of document.querySelectorAll("[data-usage-strip]")) {
    if (!section.querySelector("[data-usage-optional]")) section.remove();
  }
}

const PROVIDER_LOGIN_HINTS = { "claude-code": "run `claude auth login`" };

/** One provider the sequences rely on: identity, credentials, live quota. */
function providerCard(provider) {
  const authEntry = (state.auth ?? []).find((a) => a.provider === provider);
  const configured = authEntry?.configured;
  return h("div", { class: "card bg-base-200 border" },
    h("div", { class: "card-body gap-2 p-4" },
      h("div", { class: "flex items-center gap-2 wrap-mobile" },
        h("span", { class: "font-mono font-semibold" }, provider),
        configured
          ? h("span", { class: "badge badge-success badge-xs badge-soft" },
              `✓ ${authEntry.label ?? AUTH_SOURCE_LABELS[authEntry.source] ?? authEntry.source ?? "authenticated"}`)
          : h("span", { class: "badge badge-error badge-xs badge-soft" }, "not authenticated"),
        h("span", { class: "text-xs opacity-50 ml-auto", "data-usage-plan": provider }),
      ),
      configured
        ? h("div", { class: "flex flex-col gap-1.5", "data-usage-provider": provider },
            h("div", { class: "text-xs opacity-40" }, "checking usage…"))
        : h("div", { class: "text-xs opacity-60" }, `No credentials — ${PROVIDER_LOGIN_HINTS[provider] ?? "run `pi` and `/login`"}.`),
    ),
  );
}

// pi's credential-source ids, translated to where the login actually lives.
const AUTH_SOURCE_LABELS = { stored: "pi login", environment: "external login", runtime: "runtime key" };

/** The four sequence mutations, routed through whichever save channel owns the
 * models array. `withModels(fn, structural)` runs fn(owner) where owner.models
 * is the sequence; `emptyMeansInherit` drops the array when the last entry
 * goes (scope overrides revert to inheriting; the global sequence keeps []). */
function sequenceOps(withModels, { emptyMeansInherit = false } = {}) {
  return {
    move: (index, delta) => withModels((owner) => {
      const [step] = owner.models.splice(index, 1);
      owner.models.splice(index + delta, 0, step);
    }, true),
    patch: (index, mutate, structural = false) => withModels((owner) => mutate(owner.models[index]), structural),
    remove: (index) => withModels((owner) => {
      owner.models.splice(index, 1);
      if (emptyMeansInherit && !owner.models.length) delete owner.models;
    }, true),
    add: (ref, account) => withModels((owner) => { owner.models = [...(owner.models ?? []), { model: ref, ...(account && { account }) }]; }, true),
  };
}

/** One step of a sequence: a card hanging on the wire. `ops` routes edits to
 * whichever sequence this card belongs to (global or a scope's). */
/** How a login reads in the UI: the account name and, when the provider says,
 * who it is signed in as. No account is the machine's own login. */
function loginLabel(provider, account) {
  const authEntry = (state.auth ?? []).find((a) => a.provider === provider);
  const who = account ? authEntry?.accounts?.find((a) => a.name === account)?.label : authEntry?.machineLabel;
  return `${account ?? "this machine's login"}${who ? ` · ${who}` : ""}`;
}

/** The logins a sequence entry for `ref` can still run on: the same model on a
 * login another entry already has is that entry's candidate, not a fallback.
 * "" is the machine's own login. */
function freeLogins(ref, models, except) {
  const provider = ref.split("/")[0];
  const authEntry = (state.auth ?? []).find((a) => a.provider === provider);
  const taken = new Set(models.filter((m, i) => i !== except && m.model === ref).map((m) => m.account ?? ""));
  const logins = [...(authEntry?.configured !== false ? [""] : []), ...(authEntry?.accounts ?? []).map((a) => a.name)];
  return logins.filter((login) => !taken.has(login));
}

function modelCard(entry, index, models, ops, opts = {}) {
  const total = models.length;
  const meta = (state.catalog ?? []).find((m) => m.ref === entry.model);
  const canReason = meta ? meta.reasoning : true;
  const supported = meta?.tools ?? ALL_TOOLS();
  const provider = entry.model.split("/")[0];
  const authEntry = (state.auth ?? []).find((a) => a.provider === provider);
  const defaultReasoning = state.overview?.defaultReasoning ?? "high";

  return h("div", { class: "chain-step" },
    h("div", { class: `chain-node ${index === 0 ? "is-lead" : ""}` }, String(index + 1)),
    h("div", { class: `card ${opts.compact ? "bg-base-100" : "bg-base-200"} border` },
      h("div", { class: `card-body gap-3 ${opts.compact ? "p-3" : "p-4"}` },
        h("div", { class: "flex items-center gap-2 wrap-mobile" },
          h("span", { class: "chain-role" }, index === 0 ? "leads every turn" : "fallback"),
          !meta ? h("span", { class: "badge badge-error badge-xs badge-soft", title: "not in pi's model registry" }, "unknown model") : null,
          meta && authEntry && !authEntry.configured
            ? h("span", { class: "badge badge-error badge-xs badge-soft", title: "no credentials for this provider" }, "no auth")
            : null,
          h("div", { class: "flex items-center gap-1 ml-auto" },
            h("button", { class: "btn btn-ghost btn-xs", disabled: index === 0, "aria-label": "move up", onclick: () => ops.move(index, -1) }, "↑"),
            h("button", { class: "btn btn-ghost btn-xs", disabled: index === total - 1, "aria-label": "move down", onclick: () => ops.move(index, 1) }, "↓"),
            h("button", { class: "btn btn-ghost btn-xs text-error", onclick: () => ops.remove(index) }, "remove"),
          ),
        ),
        h("div", { class: "grid-2 gap-4" },
          labeled("Model", h("input", { class: "input input-sm w-full font-mono", value: entry.model, list: "models-list",
            onchange: (e) => { const v = e.target.value.trim(); if (v) ops.patch(index, (m) => { m.model = v; }, true); } })),
          labeled("Reasoning",
            canReason
              ? h("select", { class: "select select-sm w-full", onchange: (e) => ops.patch(index, (m) => { m.reasoning = e.target.value === defaultReasoning ? undefined : e.target.value; }) },
                  REASONING_LEVELS().map((level) => h("option", { value: level, selected: (entry.reasoning ?? defaultReasoning) === level }, level)))
              : h("div", { class: "text-sm opacity-50", style: "padding:0.3rem 0" }, "not a reasoning model"),
            canReason ? "Thinking effort while this model drives a turn." : undefined),
        ),
        accountField(entry, index, models, ops, authEntry),
        labeled("Tools",
          h("div", { class: "flex flex-wrap gap-3 py-1" },
            supported.map((tool) => {
              const enabled = !entry.tools || entry.tools.includes(tool);
              return h("label", { class: "label cursor-pointer gap-2 text-sm" },
                h("input", { type: "checkbox", class: "checkbox checkbox-sm", checked: enabled, onchange: (e) => ops.patch(index, (m) => {
                  const current = m.tools ?? [...supported];
                  const next = e.target.checked ? [...new Set([...current, tool])] : current.filter((t) => t !== tool);
                  m.tools = next.length >= supported.length ? undefined : next;
                }) }),
                tool,
              );
            }),
          ),
          "Only tools this model's runtime actually has are listed. A workspace's own tool limits still apply on top."),
        meta
          ? h("div", { class: "text-xs opacity-50 font-mono flex items-center gap-3 flex-wrap" },
              h("span", {}, meta.name),
              h("span", {}, `${fmtContext(meta.contextWindow)} context`),
            )
          : null,
      ),
    ),
  );
}

/** Which login an entry runs on — only where the provider has more than the
 * machine's own, and only logins this model isn't already on elsewhere. */
function accountField(entry, index, models, ops, authEntry) {
  const accounts = authEntry?.accounts ?? [];
  if (!accounts.length && !entry.account) return null;
  const current = entry.account ?? "";
  const choices = [...new Set([current, ...freeLogins(entry.model, models, index)])];
  const signedIn = (login) => !login || accounts.some((a) => a.name === login);
  return labeled("Account",
    h("select", { class: "select select-sm w-full", onchange: (e) => ops.patch(index, (m) => { m.account = e.target.value || undefined; }, true) },
      choices.map((login) => h("option", { value: login, selected: login === current },
        `${loginLabel(entry.model.split("/")[0], login || undefined)}${signedIn(login) ? "" : " · not signed in"}`))),
    `Another login of this provider, added with: eleven login ${entry.model.split("/")[0]}. List the model again on a second login to fail over when one runs out.`);
}

/** A full sequence editor: the chain of cards plus the add-model row. */
function sequenceEditor(models, ops, opts = {}) {
  const addInput = h("input", { class: "input input-sm w-72 font-mono", list: "models-list",
    placeholder: models.length ? "add a fallback model" : "provider/model-id" });
  // Adding a model the sequence already runs puts it on the next free login —
  // the same model on the same login again would be a fallback to itself.
  const add = () => {
    const value = addInput.value.trim();
    if (!value) return;
    const login = models.some((m) => m.model === value) ? freeLogins(value, models)[0] : undefined;
    ops.add(value, login || undefined);
  };
  return h("div", { class: "flex flex-col gap-4" },
    models.length ? h("div", { class: "chain" }, models.map((entry, index) => modelCard(entry, index, models, ops, opts))) : null,
    h("div", { class: "flex gap-2 items-center stack-mobile", style: "padding-left: 2.4rem" },
      addInput,
      h("button", { class: "btn btn-sm btn-primary", onclick: add }, "Add"),
    ),
  );
}

/** An attempt that already ran tools is the one case the daemon won't fail over
 * on its own: it asks instead. This is the switch that tells it not to. */
function autoFailoverToggle(config) {
  return h("div", { class: "flex items-center gap-2 text-sm", style: "padding-left: 2.4rem" },
    h("label", { class: "label cursor-pointer gap-2 text-sm" },
      h("input", { type: "checkbox", class: "toggle toggle-sm", checked: config.autoFailover === true,
        onchange: (e) => queueSave((next) => {
          next.autoFailover = e.target.checked ? true : undefined;
          return next;
        }) }),
      "continue on the next model automatically",
    ),
    info("When a turn dies after its tools already ran, eleven normally asks before retrying — a rewound transcript can't undo what those tools did. With this on, the next model picks the turn up where it stopped, no buttons."),
  );
}

async function viewModels() {
  // The catalog and auth statuses barely change — fetch them once per session,
  // not on every structural re-render.
  const [config, catalog, auth] = await Promise.all([
    cachedGet("/config"),
    state.catalog ?? api.get("/models"),
    state.auth ?? api.get("/providers"),
  ]);
  state.config = config;
  state.catalog = catalog;
  state.auth = auth;
  const models = config.models ?? [];

  const ops = sequenceOps((fn, structural) => queueSave((next) => { fn(next); return next; }, { structural }));

  view.replaceChildren(
    pageTitle("Models"),
    modelsDatalist(),
    h("div", { class: "max-w-3xl flex flex-col gap-4" },
      h("p", { class: "text-sm opacity-60", style: "max-width: 40rem" },
        "Every turn starts on the first model. When it fails, the turn retries down the wire — same conversation, next model. Workspaces, groups and topics can carry their own sequence instead of this one."),
      models.length === 0 ? h("div", { class: "alert" }, "No models yet — add one below to bring eleven to life.") : null,
      sequenceEditor(models, ops),
      autoFailoverToggle(config),
      providersSection(),
    ),
  );
  void loadUsage();
}

/** Every provider referenced by any sequence (global, workspace, group or
 * topic) — derived from the config the page already holds, so it can't drift
 * from what the cards below show. */
function providersInUse() {
  const refs = [];
  const scope = (s) => {
    for (const entry of s?.models ?? []) refs.push(entry.model);
  };
  scope(state.config);
  for (const workspace of Object.values(state.config?.workspaces ?? {})) {
    scope(workspace);
    for (const channel of workspace.channels ?? []) {
      for (const owner of [...Object.values(channel.groups ?? {}), ...Object.values(channel.users ?? {})]) {
        scope(owner);
        for (const topic of Object.values(owner.topics ?? {})) scope(topic);
      }
    }
  }
  return [...new Set(refs.map((ref) => ref.split("/")[0]).filter(Boolean))].sort();
}

/** Auth + subscription usage live per provider, not per model — so they get
 * their own section: rich cards for the providers the sequences actually use,
 * the rest tucked into a quiet disclosure. */
function providersSection() {
  const inUse = providersInUse();
  const others = (state.auth ?? []).filter((entry) => !inUse.includes(entry.provider));
  return h("div", { class: "flex flex-col gap-3 mt-4" },
    sectionLabel("Providers"),
    inUse.length === 0 ? h("div", { class: "text-sm opacity-50" }, "No providers in use yet — they show up here once a model is added.") : null,
    ...inUse.map((provider) => providerCard(provider)),
    others.length
      ? h("div", { class: "collapse collapse-arrow bg-base-200 border", "data-collapse": "providers:others" },
          h("input", { type: "checkbox" }),
          h("div", { class: "collapse-title flex items-center gap-2 min-h-0 py-2 text-sm" },
            h("span", { class: "opacity-60" }, "Other providers"),
            h("span", { class: "badge badge-ghost badge-xs" }, String(others.length)),
            h("span", { class: "text-xs opacity-40 ml-auto mr-2" }, `${others.filter((entry) => entry.configured).length} authenticated`),
          ),
          h("div", { class: "collapse-content flex flex-col gap-1" },
            h("p", { class: "text-xs opacity-50" }, "Every provider pi knows. Authenticate with `pi` and `/login` (or keys in ~/.pi/agent/auth.json); Claude Code uses `claude auth login`."),
            ...others.map((entry) =>
              h("div", { class: "flex items-center gap-2 font-mono text-xs py-1" },
                h("span", {}, entry.provider),
                entry.configured
                  ? h("span", { class: "text-success" }, `✓ ${entry.label ?? AUTH_SOURCE_LABELS[entry.source] ?? entry.source ?? "authenticated"}`)
                  : h("span", { class: "opacity-40" }, "—"),
              ),
            ),
          ),
        )
      : null,
  );
}

export { ALL_TOOLS, modelsDatalist, loadUsage, sequenceOps, sequenceEditor, viewModels, providersInUse };
