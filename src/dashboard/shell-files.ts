/** The app shell, relative to `public/`: every file a cold start of the
 *  dashboard needs. The shell version announced to open pages is stamped from
 *  these, so a module missing here is one whose edits never tell a page to
 *  reload. `public/sw.js` keeps the same list for its cache (`SHELL`). */
export const SHELL_FILES = [
  "index.html",
  "app.js",
  "state.js",
  "api.js",
  "ui.js",
  "format.js",
  "channels.js",
  "chrome.js",
  "router.js",
  "modals.js",
  "attachments.js",
  "running.js",
  "transcript.js",
  "phone.js",
  "config.js",
  "models.js",
  "workspaces.js",
  "usage.js",
  "settings.js",
  "thread-head.js",
  "composer.js",
  "thread-pane.js",
  "launcher.js",
  "threads.js",
  "socket.js",
  "dom.js",
  "live-turn.js",
  "markdown.js",
  "vendor/marked.esm.js",
  "message-display.js",
  "nav-drag.js",
  "waveform.js",
  "lightbox.js",
  "snapshot.js",
  "style.css",
  // The PWA half of the shell. sw.js is in here so that editing the worker
  // reloads the open pages too — otherwise the new one installs but the page
  // that would register it never restarts to notice.
  "sw.js",
  "manifest.webmanifest",
];
