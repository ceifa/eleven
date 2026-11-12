/* The Workspaces view: each workspace's agent settings and channels, the
   people, groups and topics a channel knows, and the pairing requests. */

import { state, view } from "./state.js";
import { api, cachedGet, invalidate } from "./api.js";
import { h, info, labeled, pageTitle, sectionLabel, toast } from "./ui.js";
import { timeAgo } from "./format.js";
import { CHANNEL_ICONS, wordsFor } from "./channels.js";
import { render } from "./router.js";
import { queueSave, updateWorkspace } from "./config.js";
import { ALL_TOOLS, modelsDatalist, sequenceEditor, sequenceOps } from "./models.js";

/* ---------- workspaces view (agent + channels together) ---------- */

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

  const children = [
    pageTitle("Workspaces"),
    modelsDatalist(),
    pairing.length ? pairingPanel(pairing) : null,
    ...Object.entries(state.config.workspaces).map(([name, workspace]) => workspaceCard(name, workspace)),
    h("section", { class: "section max-w-3xl" },
      sectionLabel("Add workspace"),
      addWorkspaceForm(),
    ),
  ];
  view.replaceChildren(...children.filter(Boolean));
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

function workspaceCard(name, workspace) {
  return h("section", { class: "scope-block" },
    h("div", { class: "flex flex-col gap-6" },
      // scope-head, not wrap-mobile: wrapping sent "remove workspace" to a line
      // of its own, so a phone spent a whole row on a button nobody presses.
      // The path is what gives way instead — it truncates.
      h("div", { class: "scope-head scope-title flex items-center gap-3" },
        h("h2", { class: "display text-xl" }, name),
        h("span", { class: "text-xs opacity-50 font-mono truncate min-w-0" }, workspace.path),
        h("button", { class: "btn btn-ghost btn-xs ml-auto shrink-0 text-error", onclick: () =>
          queueSave((next) => { delete next.workspaces[name]; return next; }, { structural: true }) },
          h("span", { class: "hide-mobile" }, "remove workspace"), h("span", { class: "mobile-only" }, "remove")),
      ),

      // -- channels: how the world reaches this workspace --
      h("div", { class: "flex flex-col gap-3" },
        sectionLabel("Channels"),
        ...(workspace.channels ?? []).map((channel, index) => channelCard(name, channel, index)),
        (workspace.channels ?? []).length === 0
          ? h("div", { class: "text-sm opacity-50" }, "No channels — this workspace is dashboard-only.")
          : null,
        addChannelForm(name),
      ),

      // -- agent settings --
      h("div", { class: "flex flex-col gap-3" },
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
      ),
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
        h("button", { class: "btn btn-ghost btn-xs ml-auto shrink-0 text-error", onclick: () =>
          updateWorkspace(workspaceName, (ws) => { ws.channels = (ws.channels ?? []).filter((_, i) => i !== index); }, { structural: true }) }, "remove"),
      ),
      // No grid here: the two empty cells that used to keep the token in the
      // first third of a grid-3 became two empty *rows* the moment the grid
      // collapsed to one column, which is a finger's worth of blank screen.
      h("div", { class: "field-third" },
        labeled("Bot token", h("input", { type: "password", class: "input input-sm w-full font-mono", value: channel.token,
          onchange: (e) => save({ token: e.target.value }) })),
      ),
      h("div", { class: "flex flex-col gap-2" },
        h("div", { class: "text-xs dim-label flex items-center gap-1.5" }, "Users",
          info("Who can DM this bot. Strangers who message it become pairing requests; names and usernames fill in automatically from traffic.")),
        ...Object.entries(channel.users ?? {}).map(([id, user]) => userRow(workspaceName, index, id, user, words)),
        h("input", { class: "input input-xs w-40 font-mono", placeholder: "add user by id", onchange: (e) => {
          const id = e.target.value.trim();
          if (/^\d+$/.test(id)) updateWorkspace(workspaceName, (ws) => { const ch = ws.channels[index]; ch.users = { ...ch.users, [id]: {} }; }, { structural: true });
        } }),
      ),
      h("div", { class: "flex flex-col gap-2" },
        h("div", { class: "text-xs dim-label flex items-center gap-1.5" }, words.groups, info(words.groupsInfo)),
        ...Object.entries(channel.groups ?? {}).map(([id, group]) => groupRow(workspaceName, index, id, group, words)),
        Object.keys(channel.groups ?? {}).length === 0 ? h("span", { class: "text-xs opacity-50" }, words.groupsEmpty) : null,
      ),
    ),
  );
}

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
      h("div", { class: "join ml-auto" },
        h("button", { class: `btn btn-xs join-item ${custom ? "" : "btn-primary"}`, onclick: () => custom && setPrompt(undefined, true) }, "built-in"),
        h("button", { class: `btn btn-xs join-item ${custom ? "btn-primary" : ""}`,
          onclick: () => !custom && setPrompt(state.overview?.builtinSystemPrompt ?? "", true) }, "custom"),
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
        ? h("button", { class: "btn btn-xs btn-ghost", onclick: () => mutateScope((s) => { delete s.models; }, true) }, "revert to inherited")
        : h("button", { class: "btn btn-xs", onclick: () =>
            mutateScope((s) => { s.models = structuredClone(inherited.entries); }, true) }, "customize"),
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

/**
 * The topics of whatever owns them — a group, or a person, since a bot with
 * topic mode enabled has topics in its DMs too. `select` picks the owner out of
 * a draft config so the same editor can write to either place.
 * Adding/removing a topic changes the rendered rows, so those re-render;
 * editing a topic's title or prompt updates in place.
 */
function topicsSection(workspaceName, owner, inherited, select, words) {
  const patchTopic = (topicId, patch, structural = false) =>
    updateWorkspace(workspaceName, (ws) => {
      const target = select(ws);
      const topics = { ...target.topics };
      if (patch === null) delete topics[topicId];
      else topics[topicId] = { ...topics[topicId], ...patch };
      target.topics = Object.keys(topics).length ? topics : undefined;
    }, { structural });
  return [
    h("div", { class: "text-xs dim-label mt-1 flex items-center gap-1.5" }, words.topics, info(words.topicsInfo)),
    ...Object.entries(owner.topics ?? {}).map(([topicId, topic]) =>
      h("div", { class: "topic-block flex flex-col gap-2" },
        h("div", { class: "topic-head flex items-center gap-2" },
          h("input", { class: "input input-xs w-44", value: topic.title ?? "", placeholder: `${words.topic} name (optional)`,
            onchange: (e) => patchTopic(topicId, { title: e.target.value.trim() || undefined }) }),
          h("span", { class: "font-mono text-xs opacity-50" }, `${words.topic} ${topicId}`),
          topic.appendSystemPrompt ? h("span", { class: "badge badge-warning badge-xs badge-soft" }, "+prompt") : null,
          modelsBadge(topic),
          h("button", { class: "btn btn-ghost btn-xs text-error ml-auto", onclick: () => patchTopic(topicId, null, true) }, "remove"),
        ),
        scopeSequenceField(topic, inherited,
          (fn, structural) => updateWorkspace(workspaceName, (ws) => fn(select(ws).topics[topicId]), { structural })),
        appendField(topic.appendSystemPrompt, (v) => patchTopic(topicId, { appendSystemPrompt: v })),
      ),
    ),
    h("input", { class: "input input-xs w-44 font-mono", placeholder: `add ${words.topic} by id`, onchange: (e) => {
      const topicId = e.target.value.trim();
      if (/^\d+$/.test(topicId)) patchTopic(topicId, {}, true);
    } }),
  ];
}

function userRow(workspaceName, chIndex, id, user, words) {
  const patchUser = (patch) => updateWorkspace(workspaceName, (ws) => {
    const ch = ws.channels[chIndex];
    ch.users = { ...ch.users, [id]: { ...ch.users?.[id], ...patch } };
  });
  return h("div", { class: "collapse collapse-arrow border", "data-collapse": `user:${workspaceName}:${chIndex}:${id}` },
    h("input", { type: "checkbox" }),
    h("div", { class: "collapse-title flex items-center gap-2 min-h-0 py-2 text-sm" },
      h("span", { class: "font-semibold" }, user.name ?? id),
      user.username ? h("span", { class: "text-xs opacity-50" }, `@${user.username}`) : null,
      h("span", { class: "font-mono text-xs opacity-50" }, id),
      user.appendSystemPrompt ? h("span", { class: "badge badge-warning badge-xs badge-soft" }, "+prompt") : null,
      modelsBadge(user),
    ),
    h("div", { class: "collapse-content flex flex-col gap-3" },
      scopeSequenceField(user, inheritedSequenceFor(workspaceName),
        (fn, structural) => updateWorkspace(workspaceName, (ws) => fn(ws.channels[chIndex].users[id]), { structural })),
      appendField(user.appendSystemPrompt, (v) => patchUser({ appendSystemPrompt: v })),
      // A Telegram bot with topic mode enabled has topics in its DMs; a Discord DM is one conversation.
      ...(words.dmTopics ? topicsSection(workspaceName, user, inheritedSequenceFor(workspaceName, user, "the DM"), (ws) => ws.channels[chIndex].users[id], words) : []),
      h("button", { class: "btn btn-ghost btn-xs self-start text-error", onclick: () =>
        updateWorkspace(workspaceName, (ws) => { const ch = ws.channels[chIndex]; const users = { ...ch.users }; delete users[id]; ch.users = users; }, { structural: true }) }, "remove user"),
    ),
  );
}

function groupRow(workspaceName, chIndex, id, group, words) {
  const patchGroup = (patch, opts) => updateWorkspace(workspaceName, (ws) => {
    const ch = ws.channels[chIndex];
    ch.groups = { ...ch.groups, [id]: { ...ch.groups?.[id], ...patch } };
  }, opts);
  return h("div", { class: "collapse collapse-arrow border", "data-collapse": `group:${workspaceName}:${chIndex}:${id}` },
    h("input", { type: "checkbox" }),
    h("div", { class: "collapse-title flex items-center gap-2 min-h-0 py-2 text-sm" },
      h("span", { class: "font-semibold" }, group.title ?? id),
      h("span", { class: "font-mono text-xs opacity-50" }, id),
      group.appendSystemPrompt ? h("span", { class: "badge badge-warning badge-xs badge-soft" }, "+prompt") : null,
      modelsBadge(group),
      // Hidden on a phone: it is a setting, and the row that carries it already
      // has a name, an id and two badges fighting over 300 pixels. Open the row
      // and the toggle it describes is the first thing in there.
      h("span", { class: "text-xs opacity-50 ml-auto mr-2 hide-mobile" }, group.requireMention === false ? "replies freely" : "@mention required"),
    ),
    h("div", { class: "collapse-content flex flex-col gap-3" },
      h("div", { class: "flex items-center gap-4" },
        h("label", { class: "label cursor-pointer gap-2 text-sm" },
          h("input", { type: "checkbox", class: "toggle toggle-sm", checked: group.requireMention !== false,
            onchange: (e) => patchGroup({ requireMention: e.target.checked ? undefined : false }) }),
          "require @mention",
        ),
        h("button", { class: "btn btn-ghost btn-xs text-error ml-auto", onclick: () =>
          updateWorkspace(workspaceName, (ws) => { const ch = ws.channels[chIndex]; const groups = { ...ch.groups }; delete groups[id]; ch.groups = groups; }, { structural: true }) }, `remove ${words.group}`),
      ),
      scopeSequenceField(group, inheritedSequenceFor(workspaceName),
        (fn, structural) => updateWorkspace(workspaceName, (ws) => fn(ws.channels[chIndex].groups[id]), { structural })),
      appendField(group.appendSystemPrompt, (v) => patchGroup({ appendSystemPrompt: v })),
      ...topicsSection(workspaceName, group, inheritedSequenceFor(workspaceName, group, `the ${words.group}`), (ws) => ws.channels[chIndex].groups[id], words),
    ),
  );
}

function addChannelForm(workspaceName) {
  const types = state.overview?.channelTypes ?? ["telegram"];
  const token = h("input", { class: "input input-sm flex-1 font-mono", placeholder: wordsFor(types[0]).tokenHint });
  const type = h("select", { class: "select select-sm w-32", onchange: (e) => { token.placeholder = wordsFor(e.target.value).tokenHint; } },
    types.map((t) => h("option", { value: t }, t)));
  const name = h("input", { class: "input input-sm w-28 font-mono", placeholder: "name" });
  return disclosure("Add channel",
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

function addWorkspaceForm() {
  const name = h("input", { class: "input input-sm w-36 font-mono", placeholder: "name" });
  const path = h("input", { class: "input input-sm flex-1 font-mono", placeholder: "~/path/to/directory" });
  return h("div", { class: "flex gap-2 stack-mobile" }, name, path,
    h("button", { class: "btn btn-sm btn-primary", onclick: () => {
      if (!name.value.trim() || !path.value.trim()) return;
      queueSave((next) => { next.workspaces[name.value.trim()] = { path: path.value.trim() }; return next; }, { structural: true });
    } }, "Add"),
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
