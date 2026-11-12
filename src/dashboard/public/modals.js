/* The one modal the page has, the JSON tree it inspects payloads with, and the
   things that open in it: a provider request, a tool call, a thread's skills. */

import { state } from "./state.js";
import { api } from "./api.js";
import { h, toast, withLoading } from "./ui.js";
import { dayLabel, fmtBytes, fmtTime } from "./format.js";

// ---- JSON viewer -------------------------------------------------------
// Provider payloads nest deep (system prompt, tool schemas, message history);
// a flat <pre> means scrolling past everything to find one field. This renders
// a collapsible, syntax-highlighted tree instead. Container nodes lazy-build
// their children on first open, so a huge payload costs nothing until you
// actually drill into it.

const isContainer = (v) => v !== null && typeof v === "object";

// Long strings (a whole system prompt lands in one value) would flood the
// panel, so anything over this many characters is clamped to a preview with a
// "more" toggle that reveals the rest in place.
const STRING_CLAMP = 240;

function jsonStringValue(value) {
  const full = JSON.stringify(value); // includes the surrounding quotes
  if (full.length <= STRING_CLAMP) return h("span", { class: "json-string" }, full);

  const span = h("span", { class: "json-string" });
  const text = h("span", {});
  const toggle = h("button", { class: "json-expand" });
  let open = false;
  const set = (o) => {
    open = o;
    text.textContent = open ? full : full.slice(0, STRING_CLAMP) + '…"';
    toggle.textContent = open ? "less" : `more (${full.length.toLocaleString()} chars)`;
  };
  toggle.addEventListener("click", (e) => { e.stopPropagation(); set(!open); }); // don't also toggle a parent branch
  set(false);
  span.append(text, " ", toggle);
  return span;
}

function jsonPrimitive(value) {
  if (value === null) return h("span", { class: "json-null" }, "null");
  const t = typeof value;
  if (t === "string") return jsonStringValue(value);
  if (t === "number") return h("span", { class: "json-number" }, String(value));
  if (t === "boolean") return h("span", { class: "json-bool" }, String(value));
  return h("span", {}, String(value));
}

// The "key:" prefix on a line — a quoted string for object members, a dim
// index for array elements, nothing for the root.
function jsonKey(key) {
  if (key === null) return [];
  const label = typeof key === "number"
    ? h("span", { class: "json-index" }, String(key))
    : h("span", { class: "json-key" }, `"${key}"`);
  return [label, h("span", { class: "json-punct" }, ": ")];
}

function jsonNode(key, value, depth, ctx) {
  if (!isContainer(value)) return h("div", { class: "json-line" }, ...jsonKey(key), jsonPrimitive(value));

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";
  const wrap = h("div", { class: "json-node" });

  if (entries.length === 0) {
    wrap.append(h("div", { class: "json-line" }, ...jsonKey(key), h("span", { class: "json-punct" }, open + close)));
    return wrap;
  }

  const caret = h("span", { class: "json-caret" });
  const noun = isArray ? "item" : "key";
  const count = h("span", { class: "json-count" }, `${entries.length} ${noun}${entries.length === 1 ? "" : "s"}`);
  const header = h("div", { class: "json-line json-branch" },
    caret, ...jsonKey(key), h("span", { class: "json-punct" }, open),
    h("span", { class: "json-ellipsis" }, "…"), h("span", { class: "json-punct json-inline-close" }, close), count);
  const children = h("div", { class: "json-children" });
  const closeRow = h("div", { class: "json-line json-close-row" }, h("span", { class: "json-punct" }, close));
  wrap.append(header, children, closeRow);

  // A single .is-open class on the node is the source of truth: CSS drives
  // which parts show (children + closing row vs. the "… } 5 keys" preview).
  let isOpen = false;
  let built = false;
  const set = (openState) => {
    isOpen = openState;
    if (isOpen && !built) {
      for (const [k, v] of entries) children.append(jsonNode(k, v, depth + 1, ctx));
      built = true;
    }
    caret.textContent = isOpen ? "▾" : "▸";
    wrap.classList.toggle("is-open", isOpen);
  };
  header.addEventListener("click", () => set(!isOpen));
  ctx.nodes.push(set);
  set(depth < ctx.autoDepth); // shallow levels start expanded for an at-a-glance overview
  return wrap;
}

function jsonTree(value) {
  const ctx = { nodes: [], autoDepth: 2 };
  const el = h("div", { class: "json-viewer text-xs font-mono" }, jsonNode(null, value, 0, ctx));
  return {
    el,
    // Loop by growing index: opening a node lazy-appends its children's
    // setters to ctx.nodes, and this keeps expanding them too.
    expandAll: () => { for (let i = 0; i < ctx.nodes.length; i++) ctx.nodes[i](true); },
    collapseAll: () => { for (let i = ctx.nodes.length - 1; i >= 0; i--) ctx.nodes[i](i === 0); }, // keep the root open
  };
}

// Shared modal shell: title, subtitle, a right-aligned toolbar of buttons, and
// a body. Only one modal exists at a time (fixed id), so opening a new one
// replaces the last.
function openModal(title, subtitle, toolbar, body) {
  document.getElementById("json-modal")?.remove();
  const dialog = h("dialog", { class: "modal", id: "json-modal" },
    h("div", { class: "modal-box" },
      h("div", { class: "flex items-center gap-3 mb-3 wrap-mobile" },
        h("span", { class: "section-label" }, title),
        subtitle ? h("span", { class: "font-mono text-xs opacity-60" }, subtitle) : null,
        h("div", { class: "flex items-center gap-1 ml-auto" }, ...toolbar),
        h("form", { method: "dialog" }, h("button", { class: "btn btn-xs btn-ghost" }, "✕")),
      ),
      body,
    ),
    // Full-screen click target that closes the dialog — no visible label.
    h("form", { method: "dialog", class: "modal-backdrop" }, h("button", { "aria-label": "close" })),
  );
  document.body.append(dialog);
  dialog.showModal();
}

// JSON inspector (tree ⇄ raw, expand/collapse, copy) — used for the raw
// provider-request payload.
function showJsonModal(title, subtitle, value, notice) {
  const json = JSON.stringify(value, null, 2);
  const tree = jsonTree(value);
  const raw = h("pre", { class: "json-raw text-xs", hidden: true }, json);
  const panel = h("div", { class: "bg-base-100 rounded-box p-4 overflow-auto font-mono", style: "max-height: 70vh" }, tree.el, raw);

  let showRaw = false;
  const rawBtn = h("button", { class: "btn btn-xs" }, "raw");
  rawBtn.addEventListener("click", () => {
    showRaw = !showRaw;
    raw.hidden = !showRaw;
    tree.el.hidden = showRaw;
    rawBtn.textContent = showRaw ? "tree" : "raw";
  });

  openModal(title, subtitle, [
    h("button", { class: "btn btn-xs btn-ghost", title: "expand every node", onclick: () => tree.expandAll() }, "expand"),
    h("button", { class: "btn btn-xs btn-ghost", title: "collapse to the top level", onclick: () => tree.collapseAll() }, "collapse"),
    rawBtn,
    h("button", { class: "btn btn-xs", onclick: () => navigator.clipboard.writeText(json).then(() => toast("Copied.")) }, "copy"),
  ], h("div", {}, notice ? h("p", { class: "text-sm opacity-70 mb-3" }, notice) : null, panel));
}

async function openRequestModal(request) {
  if (!state.activeThread) return; // chip clicked after the thread was cleared
  const entry = await api.get(`/requests/${state.activeThread.id}/${request.id}`).catch((e) => (toast(e.message, true), null));
  if (!entry) return;
  const bytes = fmtBytes(JSON.stringify(entry.payload, null, 2).length);
  const logical = entry.payload?.runtime === "claude-code";
  showJsonModal(logical ? "SDK invocation" : "Provider request", `${entry.model} · ${fmtTime(entry.at)} · ${bytes}`, entry.payload,
    logical ? "Claude Code runs its tool loop inside the SDK. This is the invocation, not an individual provider request." : undefined);
}

// Args (as a JSON tree) plus the recorded result (raw text, so command output
// and file contents read naturally instead of as an escaped JSON string).
// `result` is undefined when none was recorded (e.g. the turn is still running).
function showToolCallModal(name, args, result, at) {
  const hasArgs = args && Object.keys(args).length > 0;
  const argsTree = hasArgs ? jsonTree(args) : null;
  const output = result?.output ?? "";
  const resultBlock = result
    ? h("pre", { class: `toolcall-result${result.isError ? " is-error" : ""}` }, output || "(no output)")
    : h("div", { class: "opacity-60 text-xs" }, "No result recorded (turn still running?).");

  const body = h("div", { class: "overflow-auto", style: "max-height: 72vh" },
    hasArgs ? h("div", { class: "section-label mb-1" }, "arguments") : null,
    argsTree ? h("div", { class: "bg-base-100 rounded-box p-3 mb-4 font-mono text-xs" }, argsTree.el) : null,
    h("div", { class: "section-label mb-1" }, result?.isError ? "result · error" : "result"),
    h("div", { class: "bg-base-100 rounded-box p-3 font-mono text-xs" }, resultBlock),
  );

  const toolbar = [];
  if (argsTree) toolbar.push(
    h("button", { class: "btn btn-xs btn-ghost", title: "expand every arg", onclick: () => argsTree.expandAll() }, "expand"),
    h("button", { class: "btn btn-xs btn-ghost", title: "collapse args", onclick: () => argsTree.collapseAll() }, "collapse"),
  );
  if (result) toolbar.push(h("button", { class: "btn btn-xs", onclick: () => navigator.clipboard.writeText(output).then(() => toast("Copied.")) }, "copy result"));

  // Prefix with the same ⚙ the rows use, so the header clearly reads as the
  // tool that ran (not just another section label like ARGUMENTS/RESULT).
  openModal(`⚙ ${name}`, at ? `tool call · ${dayLabel(at)} ${fmtTime(at)}` : "tool call", toolbar, body);
}

async function openToolCallModal(name, args, callId, at) {
  // 404 (no result yet) resolves to undefined — the modal still shows the args.
  const result = callId && state.activeThread
    ? await api.get(`/threads/${state.activeThread.id}/toolresult?call=${encodeURIComponent(callId)}`).catch(() => undefined)
    : undefined;
  showToolCallModal(name, args, result, at);
}

/**
 * What the agent can reach for in this thread — Telegram's /skills, for the
 * thread on screen. Skills are discovered from the workspace's directory, so
 * the workspace read is the answer; the list is exactly what a turn here would
 * be offered, names and one-line descriptions included.
 */
async function openSkillsModal(thread) {
  let workspace;
  try {
    workspace = await withLoading(() => api.get(`/workspaces/${encodeURIComponent(thread.workspace)}`));
  } catch (error) {
    return toast(error.message, true);
  }
  const skills = workspace.skills ?? [];
  const rows = skills.map((skill) =>
    h("div", { class: "skill-row" },
      h("div", { class: "skill-name font-mono" }, skill.name),
      h("div", { class: "skill-desc" }, skill.description),
    ),
  );
  const body = h("div", { class: "overflow-auto", style: "max-height: 72vh" },
    rows.length
      ? h("div", { class: "skill-list" }, rows)
      : h("div", { class: "opacity-60 text-sm" }, `No skills are loaded for ${thread.workspace}.`),
  );
  // A workspace can carry dozens of them, and you open this list looking for
  // one — the filter is the difference between reading and scanning.
  const toolbar = rows.length > 8
    ? [h("input", {
        class: "input input-sm skill-filter",
        type: "search",
        placeholder: "filter",
        "aria-label": "Filter skills",
        oninput: (event) => {
          const needle = event.target.value.trim().toLowerCase();
          rows.forEach((row, index) => {
            const skill = skills[index];
            row.hidden = !!needle && !`${skill.name}\n${skill.description}`.toLowerCase().includes(needle);
          });
        },
      })]
    : [];
  openModal("🧩 skills", `${thread.workspace} · ${skills.length}`, toolbar, body);
}

export { openModal, openRequestModal, openToolCallModal, openSkillsModal };
