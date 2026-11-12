/* What a composer can carry besides text: uploaded files and voice takes. */

import { connectWaveform, WAVEFORM_BAR_COUNT } from "./waveform.js";
import { call, ok } from "./api.js";
import { CHECK_ICON, CLIP_ICON, FILE_ICON, h, MIC_ICON, toast, X_ICON } from "./ui.js";
import { fmtBytes } from "./format.js";

/* ---------- attachments ---------- */

/* Files a composer is holding, keyed the same way drafts are. Unlike a draft
   these are already on the daemon by the time they show up as a chip — the
   upload starts the moment the file is picked, so pressing Enter sends a list
   of receipts rather than a request that has to carry megabytes. They are not
   persisted: an upload is seconds-old work, and the sweep would outlive the
   tab's memory of it anyway. */
const attached = new Map();

/** How a stored file is fetched back — for a thumbnail here, or a download.
 *  The type travels with it because the daemon refuses to guess: only the
 *  renderable kinds are ever served as themselves. */
const mediaUrl = (id, mime) => `/api/media/${encodeURIComponent(id)}${mime ? `?type=${encodeURIComponent(mime)}` : ""}`;
/** The name as the user knows it — stored ids carry a uniquifying prefix. */
const mediaName = (id) => id.replace(/^[0-9a-f]{8}-/, "");

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // mirrors the daemon's own ceiling

async function uploadFile(file) {
  const response = await call(`/media?name=${encodeURIComponent(file.name || "attachment")}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  return ok(response);
}

/**
 * The attachment half of a composer: the tray of chips, the paperclip, the mic,
 * and the recorder that takes the box's place while one is running. Both
 * composers (a thread's and the launcher's) build one and place the pieces
 * themselves — what they share is everything that decides *what is attached*.
 */
function composerAttachments(key, { form, textarea, onChange = () => {} }) {
  const tray = h("div", { class: "attach-tray", hidden: true });
  const items = () => attached.get(key) ?? [];
  const setItems = (next) => (next.length ? attached.set(key, next) : attached.delete(key));

  /** `notify` is off for the first paint: a composer rebuilt over a tray that
   *  already had files in it (reopening the launcher, coming back to a thread)
   *  is restoring state, not changing it — and its caller isn't built yet. */
  function render(notify = true) {
    const list = items();
    tray.hidden = !list.length;
    tray.replaceChildren(...list.map((item) => chip(item)));
    if (notify) onChange();
  }

  function remove(item) {
    setItems(items().filter((entry) => entry !== item));
    render();
  }

  function chip(item) {
    const image = item.mime.startsWith("image/") && item.id;
    return h("div", { class: `attach-chip${item.uploading ? " is-uploading" : ""}` },
      image
        ? h("img", { class: "attach-thumb", src: mediaUrl(item.id, item.mime), alt: "" })
        : h("span", { class: "attach-glyph", "aria-hidden": "true", html: item.voice ? MIC_ICON : FILE_ICON }),
      h("span", { class: "attach-meta min-w-0" },
        h("span", { class: "attach-name truncate" }, item.voice ? "Voice message" : item.name),
        h("span", { class: "attach-size" }, item.uploading ? "uploading…" : item.voice && item.seconds ? clockDuration(item.seconds) : fmtBytes(item.bytes)),
      ),
      h("button", { class: "attach-remove", type: "button", "aria-label": `Remove ${item.name}`, onclick: () => remove(item), html: X_ICON }),
    );
  }

  /** Attach a File/Blob: the chip appears immediately and fills itself in, so a
   *  20 MB video looks like it is being worked on instead of like a freeze. */
  function add(file, { voice = false, seconds = 0 } = {}) {
    if (file.size > MAX_UPLOAD_BYTES) return toast(`${file.name || "That file"} is over ${fmtBytes(MAX_UPLOAD_BYTES)}.`, true);
    const item = { name: file.name || (voice ? "voice-note" : "attachment"), mime: file.type || "", bytes: file.size, voice, seconds, uploading: true };
    setItems([...items(), item]);
    item.upload = uploadFile(file).then(
      (stored) => {
        item.id = stored.id;
        item.mime = stored.mime || item.mime;
        item.uploading = false;
        render();
      },
      (error) => {
        toast(error.message, true);
        remove(item);
      },
    );
    render();
  }

  const picker = h("input", {
    type: "file",
    multiple: true,
    class: "sr-only",
    onchange: (event) => {
      for (const file of event.target.files) add(file);
      event.target.value = ""; // so picking the same file twice in a row still fires
    },
  });

  // Ctrl+V: a screenshot is the single most common thing anyone attaches, and
  // it never exists as a file on disk to pick. `items` is read as well as
  // `files` because a clipboard image is an item some browsers never list as a
  // file. Only intercept when something came back — pasting text stays text.
  textarea.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    const files = data?.files.length
      ? [...data.files]
      : [...(data?.items ?? [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) add(file);
  });

  // Dropping onto the composer, with the box lighting up so it is clear where
  // the file is going. dragleave fires when the pointer crosses a child too,
  // hence the depth counter.
  let dragDepth = 0;
  form.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    if (dragDepth++ === 0) form.classList.add("is-dropping");
  });
  form.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  form.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; form.classList.remove("is-dropping"); }
  });
  form.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    dragDepth = 0;
    form.classList.remove("is-dropping");
    for (const file of files) add(file);
  });

  // The input is a sibling of the button, not a child: a form control inside a
  // <button> is invalid, and browsers disagree about what happens to its clicks.
  const attachButton = h("span", { class: "composer-attach" },
    h("button", {
      class: "composer-icon",
      type: "button",
      title: "Attach a file (or paste one)",
      "aria-label": "Attach a file",
      onclick: () => picker.click(),
      html: CLIP_ICON,
    }),
    picker,
  );

  const recorder = voiceRecorder(form, (blob, seconds) => add(blob, { voice: true, seconds }));
  render(false);

  return {
    tray,
    attachButton,
    micButton: recorder.button,
    recorderBar: recorder.bar,
    /** Wait for every in-flight upload, then the receipts to send. A chip whose
     *  upload failed is already gone, so what is left is what arrived. */
    async refs() {
      await Promise.all(items().map((item) => item.upload));
      return items().filter((item) => item.id).map(({ id, mime, voice }) => ({ id, mime, voice }));
    },
    any: () => items().length > 0,
    clear() {
      recorder.cancel();
      attached.delete(key);
      render();
    },
  };
}

const clockDuration = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

// What the browser will actually record in, best first. Chrome only does webm,
// Firefox prefers ogg, Safari gives mp4 — asking in order is the whole of the
// portability story, since the daemon stores whatever bytes arrive.
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
const RECORDING_EXT = { webm: "webm", ogg: "ogg", mp4: "m4a" };
const canRecord = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

/* The take in progress, if any. A composer is torn down by things its recorder
   never hears about — opening another thread, a route change — and a microphone
   left live behind a screen nobody is looking at is not an acceptable way to
   lose track of state. */
let liveRecording;
const stopRecording = () => liveRecording?.();

/**
 * Hold-nothing voice recording: press the mic, the composer turns into a
 * recorder with a running clock, and the take lands in the tray as an ordinary
 * attachment — so it can be sent with text next to it, or thrown away. The
 * daemon transcribes it on arrival exactly like a Telegram voice note.
 */
function voiceRecorder(form, onTake) {
  const elapsed = h("span", { class: "recorder-time font-mono" }, "0:00");
  let recorder;
  let stream;
  let ticker;
  let stopWaveform;
  let startedAt = 0;
  let keep = true;

  const button = h("button", {
    class: "composer-icon composer-mic",
    type: "button",
    title: "Record a voice message",
    "aria-label": "Record a voice message",
    hidden: !canRecord(),
    onclick: () => start(),
    html: MIC_ICON,
  });

  function teardown() {
    clearInterval(ticker);
    ticker = undefined;
    stopWaveform?.();
    stopWaveform = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    recorder = undefined;
    liveRecording = undefined;
    form.classList.remove("is-recording");
  }

  async function start() {
    if (recorder) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      // Denied permission, no device, or an insecure origin — getUserMedia only
      // exists over https or on localhost, and a tunnel without TLS lands here.
      return toast(`Microphone unavailable: ${error.message ?? error}`, true);
    }
    const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    keep = true;
    recorder.addEventListener("dataavailable", (event) => event.data.size && chunks.push(event.data));
    recorder.addEventListener("stop", () => {
      const seconds = (Date.now() - startedAt) / 1000;
      const type = (recorder?.mimeType || mimeType || "audio/webm").split(";", 1)[0];
      teardown();
      if (!keep || !chunks.length) return;
      const blob = new File(chunks, `voice-note.${RECORDING_EXT[type.split("/")[1]] ?? "webm"}`, { type });
      onTake(blob, seconds);
    });
    recorder.addEventListener("error", (event) => {
      toast(`Recording failed: ${event.error?.message ?? "unknown error"}`, true);
      keep = false;
      teardown();
    });
    startedAt = Date.now();
    elapsed.textContent = "0:00";
    recorder.start();
    stopWaveform = connectWaveform(stream, [...waveform.children]);
    liveRecording = () => finish(false);
    form.classList.add("is-recording");
    ticker = setInterval(() => (elapsed.textContent = clockDuration((Date.now() - startedAt) / 1000)), 250);
  }

  function finish(shouldKeep) {
    if (!recorder) return;
    keep = shouldKeep;
    // 'stop' does the work — it is the only point where the last chunk is in.
    if (recorder.state !== "inactive") recorder.stop();
    else teardown();
  }

  const waveform = h("div", { class: "recorder-waveform", role: "img", "aria-label": "Live microphone level" },
    Array.from({ length: WAVEFORM_BAR_COUNT }, () => h("i", { class: "recorder-waveform-bar" })),
  );
  const bar = h("div", { class: "recorder" },
    h("span", { class: "recorder-dot", "aria-hidden": "true" }),
    h("span", { class: "recorder-label" }, "Recording"),
    elapsed,
    waveform,
    h("button", { class: "composer-icon", type: "button", title: "Discard", "aria-label": "Discard recording", onclick: () => finish(false), html: X_ICON }),
    h("button", { class: "composer-icon is-primary", type: "button", title: "Keep", "aria-label": "Keep recording", onclick: () => finish(true), html: CHECK_ICON }),
  );

  return { button, bar, cancel: () => finish(false) };
}

export { mediaUrl, mediaName, composerAttachments, stopRecording };
