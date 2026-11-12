/* Saving the config: one serialized chain every settings page writes through. */

import { state } from "./state.js";
import { api, invalidate, seedCache } from "./api.js";
import { toast } from "./ui.js";
import { render } from "./router.js";

// Config writes are serialized so rapid field edits compose on fresh state
// instead of racing — each save clones the latest state.config at the moment
// it runs, not when the handler fired. This lets field edits update in place
// without tearing down the view (which lost focus, scroll, and open panels).
// `structural: true` re-renders after the save (the set of rendered rows
// changed); field edits leave the DOM alone. Errors are toasted, never thrown.
let saveChain = Promise.resolve();
// A local save echoes back as a `config-changed` broadcast; while any save of
// ours is in flight, onConfigChanged ignores that echo instead of rebuilding
// the view mid-edit.
let savesInFlight = 0;

function queueSave(build, { structural = false } = {}) {
  savesInFlight++;
  const run = saveChain
    .then(async () => {
      const next = build(structuredClone(state.config));
      state.config = await api.send("PUT", "/config", next);
      // The save's own answer is the freshest config there is; the overview
      // describes the same file, so it has to go.
      seedCache("/config", state.config);
      invalidate("/overview");
      toast("Saved — applied live.");
      if (structural) await render();
    })
    .catch((error) => toast(error.message, true))
    .finally(() => savesInFlight--);
  saveChain = run; // never rejects, so the chain survives a failed save
  return run;
}

/** Mutate one workspace in place against the freshest config, then persist. */
function updateWorkspace(name, mutate, opts) {
  return queueSave((next) => {
    mutate(next.workspaces[name], next);
    return next;
  }, opts);
}

export { savesInFlight, queueSave, updateWorkspace };
