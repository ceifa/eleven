/* The Workspaces view: each workspace's agent settings and channels, the
   people, groups and topics a channel knows, and the pairing requests. */

import { state, view } from "./state.js";
import { api, cachedGet, invalidate } from "./api.js";
import { confirmButton, h, info, labeled, pageTitle, sectionLabel, toast } from "./ui.js";
import { timeAgo } from "./format.js";
import { CHANNEL_ICONS, wordsFor } from "./channels.js";
import { render } from "./router.js";
import { queueSave, updateWorkspace } from "./config.js";
import { ALL_TOOLS, modelsDatalist, sequenceEditor, sequenceOps } from "./models.js";

/* ---------- workspaces view (agent + channels together) ---------- */

/** The "+ New workspace" tab is a state of the page, not a place: there is no
 *  workspace for the address bar to name yet. */
let adding = false;
// Left behind, the form would be what a later visit opens on; and the order
// the topic lists were first shown in (below) is only worth holding while the
// page is being read.
window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#/workspaces")) return;
  adding = false;
  topicOrder.clear();
});

const workspaceHref = (name) => `#/workspaces/${encodeURIComponent(name)}`;

/** The workspace the address names, or the first one when it names none. */
function workspaceInHash(names) {
  let named = location.hash.split("/").slice(2).join("/");
  try { named = decodeURIComponent(named); } catch { /* a hand-typed %: no such workspace */ }
  if (names.includes(named)) return named;
  // Renamed or mistyped: say so, and don't leave the address pointing at
  // nothing. (Removing a workspace clears its own address first.)
  if (named) {
    history.replaceState(history.state, "", "#/workspaces");
    if (names.length) toast(`No workspace called ${named} — showing ${names[0]}.`, true);
  }
  return names[0];
}

async function viewWorkspaces() {
  // Scope sequence editors complete against the catalog (models-list datalist)
  // and flag unauthenticated providers; both barely change, so cache them.
  const [config, catalog, auth] = await Promise.all([
    cachedGet("/config"),
    state.catalog ?? api.get("/models").catch(() => []),
    state.auth ?? api.get("/providers").catch(() => []),
  ]);
  state.config = config;
  state.catalog = catalog;
  state.auth = auth;
  const pairing = state.overview?.pairing ?? [];
  const names = Object.keys(state.config.workspaces);
  const current = workspaceInHash(names);
  // With no workspace at all, making one is the only thing the page is for.
  const creating = adding || !names.length;

  // One workspace at a time. Stacked, a second workspace started a screen and
  // a half below the first, and finding a group meant scrolling past every
  // channel of every workspace above it.
  // filter: replaceChildren would print a null as the word.
  view.replaceChildren(...[
    pageTitle("Workspaces"),
    modelsDatalist(),
    pairing.length ? pairingPanel(pairing) : null,
    workspaceTabs(names, current, creating),
    creating ? addWorkspacePanel(names) : workspacePanel(current, state.config.workspaces[current]),
  ].filter(Boolean));
  // A dozen workspaces scroll sideways; the one being shown has to be in view.
  view.querySelector(".tab.is-active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function workspaceTabs(names, current, creating) {
  return h("nav", { class: "tabs", "aria-label": "Workspaces" },
    // The names scroll; the button after them does not, so it is never the
    // thing that scrolled out of reach.
    h("div", { class: "tabs-names" }, names.map((name) => {
      const active = !creating && name === current;
      return h("a", {
        class: `tab${active ? " is-active" : ""}`,
        href: workspaceHref(name),
        "aria-current": active ? "page" : undefined,
        // Leaving the new-workspace form for the tab the address already names
        // changes no hash, so nothing would repaint on its own. Any other tab
        // changes it, and the hash change does the painting.
        onclick: () => { if (adding) { adding = false; if (location.hash === workspaceHref(name)) void render(); } },
      }, name);
    })),
    h("button", {
      type: "button",
      class: `tab tab-add${creating ? " is-active" : ""}`,
      "aria-pressed": creating ? "true" : "false",
      onclick: () => { if (!adding) { adding = true; void render(); } },
    }, h("span", { "aria-hidden": "true" }, "+ "), "New workspace"),
  );
}

function pairingPanel(requests) {
  return h("div", { class: "card warn max-w-3xl mb-6" },
    h("div", { class: "card-body gap-2" },
      h("h2", { class: "card-title text-base" }, "Pairing requests", h("span", { class: "badge badge-warning badge-sm" }, requests.length)),
      ...requests.map((request) => {
        const isGroup = request.kind === "group";
        const title = (isGroup ? request.chatTitle : request.name) || (isGroup ? `chat ${request.chatId}` : `user ${request.userId}`);
        const meta = [
          `→ ${request.bot}`,
          isGroup ? `chat ${request.chatId}` : `user ${request.userId}`,
          isGroup && request.name ? `via ${request.name}` : null,
          `${timeAgo(request.createdAt)} ago`,
        ].filter(Boolean);
        return h("div", { class: "flex items-center gap-3 py-1" },
          pairingAvatar(request, title),
          h("div", { class: "flex-1 min-w-0" },
            h("div", { class: "flex items-center gap-2 min-w-0" },
              h("span", { class: "truncate" }, title),
              request.username ? h("span", { class: "text-xs opacity-60 font-mono shrink-0" }, `@${request.username}`) : null,
              // Worth the pixels: the name below is the folded one, and knowing
              // the sender wrote it in lookalike glyphs is most of the decision.
              request.disguised
                ? h("span", { class: "badge badge-warning badge-sm shrink-0", title: "Written in lookalike unicode — shown here folded to plain letters." }, "disguised name")
                : null,
            ),
            h("div", { class: "text-xs opacity-60 font-mono truncate" }, meta.join(" · ")),
          ),
          h("button", { class: "btn btn-success btn-sm", onclick: () => pairingAction(request.id, "approve") }, "Approve"),
          h("button", { class: "btn btn-ghost btn-sm", onclick: () => pairingAction(request.id, "deny") }, "Deny"),
        );
      }),
    ),
  );
}

/** The requester's picture, or their initial when Telegram has none to give. */
function pairingAvatar(request, title) {
  if (request.photo) return h("img", { class: "pair-avatar", src: request.photo, alt: "" });
  const initial = [...title.trim()][0]?.toUpperCase() ?? (request.kind === "group" ? "#" : "?");
  return h("div", { class: "pair-avatar pair-avatar-blank" }, initial);
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function workspacePanel(name, workspace) {
  const channels = workspace.channels ?? [];
  const agent =
    // -- the agent: what runs here, with what --
    h("div", { class: "section" },
      sectionLabel("Agent"),
      h("div", { class: "grid-3 gap-4" },
        labeled("Directory", h("input", { class: "input input-sm w-full font-mono", value: workspace.path,
          onchange: (e) => updateWorkspace(name, (ws) => { ws.path = e.target.value; }) })),
        labeled("Tools",
          h("div", { class: "flex flex-wrap gap-3 py-1" },
            ALL_TOOLS().map((tool) => {
              const enabled = !workspace.tools || workspace.tools.includes(tool);
              return h("label", { class: "label cursor-pointer gap-2 text-sm" },
                h("input", { type: "checkbox", class: "checkbox checkbox-sm", checked: enabled, onchange: (e) => updateWorkspace(name, (ws) => {
                  const current = ws.tools ?? [...ALL_TOOLS()];
                  const next = e.target.checked ? [...new Set([...current, tool])] : current.filter((t) => t !== tool);
                  ws.tools = next.length === ALL_TOOLS().length ? undefined : next;
                }) }),
                tool,
              );
            }),
          )),
      ),
      scopeSequenceField(workspace, inheritedSequenceFor(),
        (fn, structural) => updateWorkspace(name, fn, { structural })),
      systemPromptField(name, workspace),
    );
  return h("section", { class: "scope-block" },
    // -- channels: how the world reaches this workspace. First, because the
    //    people, groups and topics in them are what this page is opened for;
    //    folded, they are short enough that the agent's settings stay close. --
    h("div", { class: "section" },
      h("div", { class: "flex items-baseline gap-3" },
        sectionLabel("Channels"),
        channels.length ? null : h("span", { class: "text-sm opacity-50" }, "none — this workspace is reached from the dashboard only"),
      ),
      ...channels.map((channel, index) => channelCard(name, channel, index)),
      addChannelForm(name),
    ),
    agent,
    // Last, and on its own: it takes every channel above down with it.
    h("div", { class: "scope-end" },
      confirmButton(`Remove workspace ${name}`, () => {
        // Its address goes first, so the page does not come back asking for it.
        history.replaceState(history.state, "", "#/workspaces");
        return queueSave((next) => { delete next.workspaces[name]; return next; }, { structural: true });
      }, { loud: true }),
    ),
  );
}

function channelCard(workspaceName, channel, index) {
  const status = state.overview?.bots?.find((b) => b.name === channel.name);
  const words = wordsFor(channel.type);
  // Shallow-patch this channel against the freshest config (in place, no rebuild).
  const save = (patch) => updateWorkspace(workspaceName, (ws) => {
    ws.channels[index] = { ...ws.channels[index], ...patch };
  });
  const users = Object.entries(channel.users ?? {});
  const groups = Object.entries(channel.groups ?? {});
  return h("div", { class: "card bg-base-200" },
    h("div", { class: "card-body gap-4 p-4" },
      h("div", { class: "scope-head flex items-center gap-2" },
        h("span", { class: "shrink-0", html: CHANNEL_ICONS[channel.type] ?? "" }),
        h("span", { class: "font-mono font-semibold truncate min-w-0" }, channel.name),
        status?.username
          ? words.profile
            ? h("a", { class: "text-xs link link-hover opacity-60 hide-mobile", href: words.profile(status.username), target: "_blank", rel: "noopener" }, `@${status.username}`)
            : h("span", { class: "text-xs opacity-60 hide-mobile" }, `@${status.username}`)
          : null,
        h("span", { class: `badge badge-sm shrink-0 ${status?.connected ? "badge-success" : "badge-error"} badge-soft ml-2` }, status?.connected ? "online" : "offline"),
        confirmButton("Remove channel", () =>
          // By name, not by position: positions shift under a second click.
          updateWorkspace(workspaceName, (ws) => { ws.channels = (ws.channels ?? []).filter((other) => other.name !== channel.name); }, { structural: true }),
          { class: "ml-auto shrink-0", noun: `channel ${channel.name}` }),
      ),
      // No grid here: the two empty cells that used to keep the token in the
      // first third of a grid-3 became two empty *rows* the moment the grid
      // collapsed to one column, which is a finger's worth of blank screen.
      h("div", { class: "field-third" },
        labeled("Bot token", h("input", { type: "password", class: "input input-sm w-full font-mono", value: channel.token,
          onchange: (e) => save({ token: e.target.value }) })),
      ),
      h("div", { class: "flex flex-col gap-2" },
        h("div", { class: "text-xs dim-label flex items-center gap-1.5" }, "People", countMark(users.length),
          info("Who can DM this bot. Strangers who message it become pairing requests; names and usernames fill in automatically from traffic.")),
        ...users.map(([id, user]) => userRow(workspaceName, index, id, user, words)),
        h("input", { class: "input input-xs w-52 font-mono", placeholder: "add a person by id", "aria-label": "Add a person by id", onchange: (e) => {
          const id = e.target.value.trim();
          // Someone already on the list keeps what they have: their prompt,
          // their models and their topics are not an empty entry's to replace.
          if (/^\d+$/.test(id)) updateWorkspace(workspaceName, (ws) => { const ch = ws.channels[index]; ch.users = { ...ch.users, [id]: ch.users?.[id] ?? {} }; }, { structural: true });
        } }),
      ),
      h("div", { class: "flex flex-col gap-2" },
        h("div", { class: "text-xs dim-label flex items-center gap-1.5" }, words.groups, countMark(groups.length), info(words.groupsInfo)),
        ...groups.map(([id, group]) => groupRow(workspaceName, index, id, group, words)),
        groups.length === 0 ? h("span", { class: "text-xs opacity-50" }, words.groupsEmpty) : null,
      ),
    ),
  );
}

/** How many rows a list's label is standing over. */
const countMark = (count) => (count ? h("span", { class: "count-mark" }, String(count)) : null);

/** Custom prompts switched back to built-in this session, by workspace. */
const setAsidePrompts = new Map();

/** Workspace-level: choose the built-in personality (shown read-only) or a custom one. */
function systemPromptField(name, workspace) {
  const custom = workspace.systemPrompt != null;
  // Switching built-in/custom swaps which editor renders, so it re-renders;
  // typing in the custom editor updates in place.
  const setPrompt = (value, structural) => updateWorkspace(name, (ws) => { ws.systemPrompt = value; }, { structural });
  // prompt-editor: eight rows of monospace is a third of a phone screen, and
  // CSS cuts it down on a narrow one. It stays draggable either way.
  //
  // On built-in the block is read-only reference — the same text, printed once
  // per workspace, in front of the settings you came for — so it folds. The
  // custom one is the thing being edited and stays open.
  const editor = custom
    ? h("textarea", { class: "textarea prompt-editor w-full font-mono text-xs", rows: "8", placeholder: "your custom personality/style block…",
        onchange: (e) => setPrompt(e.target.value, false) }, workspace.systemPrompt ?? "")
    : disclosure("show the built-in prompt",
        h("textarea", { class: "textarea prompt-editor w-full font-mono text-xs opacity-60", rows: "8", readonly: true },
          state.overview?.builtinSystemPrompt ?? ""));
  return h("div", { class: "flex flex-col gap-2" },
    h("div", { class: "flex items-center gap-4" },
      h("span", { class: "text-xs dim-label flex items-center gap-1.5" }, "System prompt",
        info("The agent's personality and style. Runtime facts (workspace, date, tools) are always appended after it, whether built-in or custom.")),
      h("div", { class: "join ml-auto", role: "group", "aria-label": "System prompt" },
        h("button", { class: `btn btn-xs join-item ${custom ? "" : "btn-primary"}`, "aria-pressed": custom ? "false" : "true", onclick: () => {
          if (!custom) return;
          // One click away from a prompt somebody wrote: keep it, so the click
          // back brings it back instead of the built-in text.
          setAsidePrompts.set(name, state.config.workspaces[name]?.systemPrompt ?? workspace.systemPrompt);
          setPrompt(undefined, true);
        } }, "built-in"),
        h("button", { class: `btn btn-xs join-item ${custom ? "btn-primary" : ""}`, "aria-pressed": custom ? "true" : "false",
          onclick: () => !custom && setPrompt(setAsidePrompts.get(name) ?? state.overview?.builtinSystemPrompt ?? "", true) }, "custom"),
      ),
    ),
    editor,
  );
}

/** The sequence a scope inherits when it doesn't carry its own: the nearest
 * ancestor's, or the global one from the Models page. Call with no arguments
 * for what a workspace inherits. */
function inheritedSequenceFor(workspaceName, owner, ownerSource = "the group") {
  if (owner?.models?.length) return { entries: owner.models, source: ownerSource };
  const workspace = state.config?.workspaces?.[workspaceName];
  if (workspace?.models?.length) return { entries: workspace.models, source: "the workspace" };
  return { entries: state.config?.models ?? [], source: "the Models page" };
}

/** "+prompt": the scope appends to the system prompt. Always built, hidden
 *  when it doesn't, because the text is edited in place under an open row and
 *  the row's head has to follow without a rebuild. */
const promptBadge = (on) => h("span", { class: "badge badge-warning badge-xs badge-soft shrink-0", hidden: !on }, "+prompt");

/** How many of a group's or person's topics carry settings of their own —
 *  said on the folded row, so finding them is not a matter of opening every
 *  one to look. */
function insideBadge(owner) {
  const count = Object.values(owner.topics ?? {}).filter(isCustomized).length;
  return count
    ? h("span", { class: "badge badge-warning badge-xs badge-soft shrink-0", title: "topics inside with their own models or prompt" }, `${count} customized inside`)
    : null;
}

/** Amber badge on group/topic rows that carry their own model sequence. */
function modelsBadge(scope) {
  if (!scope.models?.length) return null;
  return h("span", {
    class: "badge badge-warning badge-xs badge-soft",
    title: scope.models.map((entry) => entry.model).join(" → "),
  }, "models");
}

/* Scope-level sequence editor (workspace, group, topic). Resting state is a
   one-line summary of what's inherited and from where; "customize" copies that
   sequence into the scope and opens the same editor the Models page uses, so
   every knob (order, reasoning, tools) is available per scope. */
function scopeSequenceField(scope, inherited, mutateScope) {
  const overridden = !!scope.models?.length;
  const header = h("div", { class: "flex items-center gap-2" },
    h("span", { class: "text-xs dim-label flex items-center gap-1.5" }, "Models",
      info("The model sequence for turns in this scope: the first entry leads, the rest are fallbacks — each with its own reasoning and tools. Customizing copies the inherited sequence here; removing every entry goes back to inheriting.")),
    h("div", { class: "ml-auto" },
      overridden
        ? h("button", { class: "btn btn-xs btn-ghost", onclick: () => mutateScope((s) => { delete s.models; }, true) }, "Revert to inherited")
        : h("button", { class: "btn btn-xs", onclick: () =>
            mutateScope((s) => { s.models = structuredClone(inherited.entries); }, true) }, "Customize"),
    ),
  );
  if (!overridden) {
    const summary = inherited.entries.map((entry) => entry.model).join(" → ") || "none configured";
    return h("div", { class: "flex flex-col gap-1" },
      header,
      h("div", { class: "font-mono text-xs opacity-50 truncate" }, `${summary} · from ${inherited.source}`),
    );
  }
  const ops = sequenceOps(mutateScope, { emptyMeansInherit: true });
  return h("div", { class: "flex flex-col gap-2" },
    header,
    sequenceEditor(scope.models, ops, { compact: true }),
  );
}

/** Group/topic-level: only an append. */
function appendField(value, onchange) {
  return labeled("Append to system prompt",
    h("textarea", { class: "textarea w-full font-mono text-xs", rows: "3",
      onchange: (e) => onchange(e.target.value.trim() || undefined) }, value ?? ""),
    "Extra instructions added at the end of the system prompt, only for this scope.");
}

/** How many topics a long list shows before it asks. A forum has a handful; a
 *  Discord server registers every channel and thread anyone ever spoke in. */
const TOPIC_CAP = 12;
/** A list folds only when that hides enough to be worth a click. */
const TOPIC_FOLD_OVER = TOPIC_CAP + 4;
/** Lists opened past the cap, and what each is being filtered by — kept here
 *  because a save rebuilds the view, and the list being read must not fold
 *  back up under the reader. Keyed by the list's owner. */
const topicListsOpen = new Set();
const topicQueries = new Map();
/** The order each list was first shown in, for as long as the page is open.
 *  Customized topics lead — but a topic that becomes customized while it is
 *  open must not jump to the top of the list from under the hand editing it. */
const topicOrder = new Map();

/** Carries its own instructions or models — the topics worth finding first. */
const isCustomized = (scope) => Boolean(scope.models?.length || scope.appendSystemPrompt);

function orderedTopics(owner, ownerKey) {
  const topics = owner.topics ?? {};
  const seen = topicOrder.get(ownerKey);
  const order = seen
    // Keep the order; drop what was removed, put what registered since last.
    ? [...seen.filter((id) => id in topics), ...Object.keys(topics).filter((id) => !seen.includes(id))]
    // First showing: the ones somebody configured, then the rest as they
    // registered (sort is stable).
    : Object.keys(topics).sort((x, y) => Number(isCustomized(topics[y])) - Number(isCustomized(topics[x])));
  topicOrder.set(ownerKey, order);
  return order.map((id) => [id, topics[id]]);
}

/**
 * The topics of whatever owns them — a group, or a person, since a bot with
 * topic mode enabled has topics in its DMs too. `select` picks the owner out of
 * a draft config so the same editor can write to either place.
 *
 * Rows, folded: a topic is a name until someone needs to change it, and nearly
 * none of them are ever changed. Printed open, each was a name field, a model
 * line and a three-row text box — a hundred of those under one server.
 * Adding/removing a topic changes the rendered rows, so those re-render;
 * editing a topic's title or prompt updates in place.
 */
function topicsSection(workspaceName, owner, inherited, select, words, ownerKey) {
  const patchTopic = (topicId, patch, structural = false) =>
    updateWorkspace(workspaceName, (ws) => {
      const target = select(ws);
      const topics = { ...target.topics };
      if (patch === null) delete topics[topicId];
      else topics[topicId] = { ...topics[topicId], ...patch };
      target.topics = Object.keys(topics).length ? topics : undefined;
    }, { structural });
  const many = words.topics.toLowerCase();
  const rows = orderedTopics(owner, ownerKey).map(([topicId, topic]) => {
    const fallback = `${words.topic} ${topicId}`;
    // A Discord thread sits in a channel, a channel in a category.
    const parent = topic.parent ? owner.topics?.[topic.parent]?.title : undefined;
    const row = { node: null, text: "" };
    const index = (title) => { row.text = `${title ?? fallback} ${parent ?? ""} ${topicId}`.toLowerCase(); };
    index(topic.title);
    const name = h("span", { class: "truncate min-w-0" }, topic.title ?? fallback);
    const toggle = h("input", { type: "checkbox", "aria-label": `${topic.title ?? fallback} — settings` });
    const prompt = promptBadge(topic.appendSystemPrompt);
    row.node = h("div", { class: "collapse collapse-arrow topic-row", "data-collapse": `topic:${ownerKey}:${topicId}` },
      toggle,
      h("div", { class: "collapse-title flex items-center gap-2 min-h-0 text-sm" },
        name,
        parent ? h("span", { class: "text-xs opacity-50 truncate min-w-0 hide-mobile" }, `in ${parent}`) : null,
        prompt,
        modelsBadge(topic),
        // Two topics can carry one name; the id is what tells them apart.
        h("span", { class: "topic-id font-mono text-xs opacity-50 ml-auto shrink-0 hide-mobile" }, topicId),
      ),
      h("div", { class: "collapse-content flex flex-col gap-3" },
        h("div", { class: "topic-head flex items-center gap-2" },
          h("input", { class: "input input-xs w-44", value: topic.title ?? "", placeholder: `${words.topic} name (optional)`, "aria-label": `${words.topic} name`,
            onchange: (e) => {
              const title = e.target.value.trim() || undefined;
              // The row's own name, and what the filter searches, follow the field.
              name.textContent = title ?? fallback;
              toggle.setAttribute("aria-label", `${title ?? fallback} — settings`);
              index(title);
              patchTopic(topicId, { title });
            } }),
          h("span", { class: "font-mono text-xs opacity-50" }, fallback),
          confirmButton("Remove", () => patchTopic(topicId, null, true), { class: "ml-auto", noun: `${words.topic} ${topic.title ?? topicId}` }),
        ),
        scopeSequenceField(topic, inherited,
          (fn, structural) => updateWorkspace(workspaceName, (ws) => fn(select(ws).topics[topicId]), { structural })),
        appendField(topic.appendSystemPrompt, (v) => { prompt.hidden = !v; patchTopic(topicId, { appendSystemPrompt: v }); }),
      ),
    );
    return row;
  });

  const folds = rows.length > TOPIC_FOLD_OVER;
  // A filter typed into a list that has since shrunk under the fold has no
  // field left to clear it from.
  if (!folds) topicQueries.delete(ownerKey);
  const more = h("button", { type: "button", class: "more-toggle", onclick: () => {
    if (!topicListsOpen.delete(ownerKey)) topicListsOpen.add(ownerKey);
    apply();
  } });
  const nothing = h("div", { class: "text-xs opacity-50", hidden: true });
  // Hides rows rather than rebuilding them: the filter is typed into, and a
  // rebuild would take the field out from under the typing.
  function apply() {
    const query = (topicQueries.get(ownerKey) ?? "").trim().toLowerCase();
    const all = !folds || topicListsOpen.has(ownerKey);
    let shown = 0;
    let matches = 0;
    for (const row of rows) {
      const match = !query || row.text.includes(query);
      if (match) matches++;
      row.node.hidden = !(match && (query || all || shown < TOPIC_CAP));
      if (!row.node.hidden) shown++;
    }
    more.hidden = Boolean(query) || !folds;
    more.textContent = all ? `Show the first ${TOPIC_CAP}` : `Show all ${rows.length} ${many}`;
    nothing.hidden = matches > 0 || !rows.length;
    nothing.textContent = `No ${words.topic} matches “${query}”.`;
  }
  apply();

  return [
    h("div", { class: "topic-list-head" },
      h("span", { class: "text-xs dim-label flex items-center gap-1.5" }, words.topics, countMark(rows.length), info(words.topicsInfo)),
      folds
        ? h("input", {
            type: "search", class: "input input-xs topic-filter", placeholder: `Filter ${rows.length} ${many}`, "aria-label": `Filter ${many}`,
            value: topicQueries.get(ownerKey) ?? "",
            oninput: (e) => { topicQueries.set(ownerKey, e.target.value); apply(); },
          })
        : null,
    ),
    rows.length ? h("div", { class: "topic-list" }, rows.map((row) => row.node), nothing) : null,
    more,
    h("input", { class: "input input-xs w-52 font-mono", placeholder: "add one by id", "aria-label": `Add a ${words.topic} by id`, onchange: (e) => {
      const topicId = e.target.value.trim();
      if (!/^\d+$/.test(topicId)) return;
      // It lands at the end of the list, which is past the fold of a long one.
      topicListsOpen.add(ownerKey);
      patchTopic(topicId, {}, true);
    } }),
  ];
}

function userRow(workspaceName, chIndex, id, user, words) {
  const patchUser = (patch) => updateWorkspace(workspaceName, (ws) => {
    const ch = ws.channels[chIndex];
    ch.users = { ...ch.users, [id]: { ...ch.users?.[id], ...patch } };
  });
  const topicCount = Object.keys(user.topics ?? {}).length;
  const prompt = promptBadge(user.appendSystemPrompt);
  return h("div", { class: "collapse collapse-arrow border", "data-collapse": `user:${workspaceName}:${chIndex}:${id}` },
    h("input", { type: "checkbox", "aria-label": `${user.name ?? id} — settings` }),
    h("div", { class: "collapse-title flex items-center gap-2 min-h-0 py-2 text-sm" },
      h("span", { class: "font-semibold truncate min-w-0" }, user.name ?? id),
      user.username ? h("span", { class: "text-xs opacity-50 shrink-0" }, `@${user.username}`) : null,
      h("span", { class: "font-mono text-xs opacity-50 hide-mobile" }, id),
      prompt,
      modelsBadge(user),
      words.dmTopics ? insideBadge(user) : null,
      words.dmTopics && topicCount
        ? h("span", { class: "text-xs opacity-50 ml-auto mr-2 shrink-0" }, plural(topicCount, words.topic))
        : null,
    ),
    h("div", { class: "collapse-content flex flex-col gap-3" },
      scopeSequenceField(user, inheritedSequenceFor(workspaceName),
        (fn, structural) => updateWorkspace(workspaceName, (ws) => fn(ws.channels[chIndex].users[id]), { structural })),
      appendField(user.appendSystemPrompt, (v) => { prompt.hidden = !v; patchUser({ appendSystemPrompt: v }); }),
      // A Telegram bot with topic mode enabled has topics in its DMs; a Discord DM is one conversation.
      ...(words.dmTopics
        ? topicsSection(workspaceName, user, inheritedSequenceFor(workspaceName, user, "the DM"), (ws) => ws.channels[chIndex].users[id], words, `${workspaceName}:${chIndex}:user:${id}`)
        : []),
      confirmButton("Remove this person", () =>
        updateWorkspace(workspaceName, (ws) => { const ch = ws.channels[chIndex]; const users = { ...ch.users }; delete users[id]; ch.users = users; }, { structural: true }),
        { class: "self-start", noun: user.name ?? id }),
    ),
  );
}

function groupRow(workspaceName, chIndex, id, group, words) {
  const patchGroup = (patch, opts) => updateWorkspace(workspaceName, (ws) => {
    const ch = ws.channels[chIndex];
    ch.groups = { ...ch.groups, [id]: { ...ch.groups?.[id], ...patch } };
  }, opts);
  const topicCount = Object.keys(group.topics ?? {}).length;
  const prompt = promptBadge(group.appendSystemPrompt);
  const mentionWords = (required) => (required ? "@mention required" : "replies freely");
  const mention = h("span", {}, mentionWords(group.requireMention !== false));
  return h("div", { class: "collapse collapse-arrow border", "data-collapse": `group:${workspaceName}:${chIndex}:${id}` },
    h("input", { type: "checkbox", "aria-label": `${group.title ?? id} — settings` }),
    h("div", { class: "collapse-title flex items-center gap-2 min-h-0 py-2 text-sm" },
      h("span", { class: "font-semibold truncate min-w-0" }, group.title ?? id),
      h("span", { class: "font-mono text-xs opacity-50 hide-mobile" }, id),
      prompt,
      modelsBadge(group),
      insideBadge(group),
      h("span", { class: "text-xs opacity-50 ml-auto mr-2 shrink-0" },
        // The count stays on a phone: it is what says this row opens into a
        // hundred more.
        topicCount ? plural(topicCount, words.topic) : null,
        // The setting is hidden there: the row already has a name and two
        // badges fighting over 300 pixels, and the toggle it describes is the
        // first thing inside.
        h("span", { class: "hide-mobile" }, topicCount ? " · " : "", mention),
      ),
    ),
    h("div", { class: "collapse-content flex flex-col gap-3" },
      h("div", { class: "flex items-center gap-4" },
        h("label", { class: "label cursor-pointer gap-2 text-sm" },
          h("input", { type: "checkbox", class: "toggle toggle-sm", checked: group.requireMention !== false,
            onchange: (e) => { mention.textContent = mentionWords(e.target.checked); patchGroup({ requireMention: e.target.checked ? undefined : false }); } }),
          "require @mention",
        ),
      ),
      scopeSequenceField(group, inheritedSequenceFor(workspaceName),
        (fn, structural) => updateWorkspace(workspaceName, (ws) => fn(ws.channels[chIndex].groups[id]), { structural })),
      appendField(group.appendSystemPrompt, (v) => { prompt.hidden = !v; patchGroup({ appendSystemPrompt: v }); }),
      ...topicsSection(workspaceName, group, inheritedSequenceFor(workspaceName, group, `the ${words.group}`), (ws) => ws.channels[chIndex].groups[id], words, `${workspaceName}:${chIndex}:group:${id}`),
      // At the end, like a person's: under the row's own chevron it was one
      // slip of the pointer from the thing people click to fold the row.
      confirmButton(`Remove this ${words.group}`, () =>
        updateWorkspace(workspaceName, (ws) => { const ch = ws.channels[chIndex]; const groups = { ...ch.groups }; delete groups[id]; ch.groups = groups; }, { structural: true }),
        { class: "self-start", noun: group.title ?? id }),
    ),
  );
}

function addChannelForm(workspaceName) {
  const types = state.overview?.channelTypes ?? ["telegram"];
  const token = h("input", { class: "input input-sm flex-1 font-mono", placeholder: wordsFor(types[0]).tokenHint });
  const type = h("select", { class: "select select-sm w-32", onchange: (e) => { token.placeholder = wordsFor(e.target.value).tokenHint; } },
    types.map((t) => h("option", { value: t }, t)));
  const name = h("input", { class: "input input-sm w-28 font-mono", placeholder: "name" });
  return disclosure("Add a channel",
    h("div", { class: "flex gap-2 items-center stack-mobile" },
      type, name, token,
      h("button", { class: "btn btn-sm", onclick: () => {
        if (!name.value.trim() || !token.value.trim()) return;
        return updateWorkspace(workspaceName, (ws) => {
          ws.channels = [...(ws.channels ?? []), { type: type.value, name: name.value.trim(), token: token.value.trim(), users: {} }];
        }, { structural: true });
      } }, "Add"),
    ),
  );
}

/**
 * A form that is not what the page is about, folded away until it is.
 *
 * This one appears once per workspace and is four empty fields each; on a phone
 * that is most of a screen, repeated, in front of the channels you came to
 * look at. On a desktop it is merely noise, which is why the fold is not
 * mobile-only.
 */
const disclosure = (label, ...children) =>
  h("details", { class: "disclosure" }, h("summary", {}, label), ...children);

/** The page behind the "+ New workspace" tab. */
function addWorkspacePanel(names) {
  const name = h("input", { class: "input input-sm w-full font-mono", placeholder: "a short name, like notes", "aria-label": "Name" });
  const path = h("input", { class: "input input-sm w-full font-mono", placeholder: "~/path/to/directory", "aria-label": "Directory" });
  const problem = h("p", { class: "text-xs text-error", role: "alert", hidden: true });
  const create = async (event) => {
    event.preventDefault();
    const wanted = name.value.trim();
    const says = !wanted ? "Give the workspace a name."
      : names.includes(wanted) ? `There is already a workspace called ${wanted}.`
      : !path.value.trim() ? "Say which directory the agent works in."
      : "";
    problem.textContent = says;
    problem.hidden = !says;
    if (says) return;
    await queueSave((next) => { next.workspaces[wanted] = { path: path.value.trim() }; return next; });
    // A save that failed has already said why; the form, and what was typed
    // into it, stays for another try.
    if (!Object.hasOwn(state.config.workspaces, wanted)) return;
    adding = false;
    if (location.hash === workspaceHref(wanted)) void render();
    else location.hash = workspaceHref(wanted);
  };
  return h("form", { class: "section max-w-md", onsubmit: create },
    h("p", { class: "text-sm opacity-60" },
      "A workspace is a directory an agent works in, with its own tools, models and prompt, and the channels that reach it."),
    labeled("Name", name),
    labeled("Directory", path),
    problem,
    h("div", { class: "flex gap-2" },
      h("button", { class: "btn btn-sm btn-primary", type: "submit" }, "Create workspace"),
      names.length ? h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => { adding = false; void render(); } }, "Cancel") : null,
    ),
  );
}

async function pairingAction(code, action) {
  try {
    await api.send("POST", `/pairing/${code}/${action}`);
    toast(action === "approve" ? "Paired." : "Request denied.");
  } catch (error) {
    toast(error.message, true);
  }
  invalidate("/overview"); // the queue this request was in just changed
  render(); // re-reads /overview and repaints the badge — no separate fetch needed
}

export { viewWorkspaces };
