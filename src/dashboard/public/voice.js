/* Half-duplex by design: the microphone never hears the agent's playback. */

/** The first moments after the tone only measure the room: road noise louder
 *  than any fixed floor would otherwise read as one endless sentence. */
export function speechDetector() {
  let noise;
  let first;
  let started;
  let lastVoice;
  let voiced = 0;
  let previous;
  return {
    sample(level, now) {
      first ??= now;
      const step = previous === undefined ? 0 : Math.min(100, now - previous);
      previous = now;
      if (now - first < 400) {
        noise = noise === undefined ? level : noise * 0.8 + level * 0.2;
        return "quiet";
      }
      const threshold = Math.max(0.015, noise * (started === undefined ? 2.8 : 1.8));
      if (level > threshold) {
        started ??= now;
        lastVoice = now;
        voiced += step;
      } else if (started === undefined) {
        noise = noise * 0.95 + level * 0.05;
      }
      if (started === undefined) return "quiet";
      if (now - lastVoice >= 1400) {
        if (voiced >= 250) return "done";
        started = lastVoice = undefined;
        voiced = 0;
        return "quiet";
      }
      return now - started >= 45_000 ? "done" : "speech";
    },
  };
}

export function spokenText(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^[\s#>*-]+/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\s+/g, " ").trim();
}

/** Each boundary checks cancellation: a late transcript must never start a
 *  turn. A turn already asked for is not asked again — a resumed loop waits
 *  for its reply instead of listening. */
export async function voiceLoop(io, signal) {
  while (!signal.aborted) {
    if (!io.pending()) {
      io.state("listening");
      const recording = await io.record(signal);
      signal.throwIfAborted();
      io.state("transcribing");
      const text = await io.transcribe(recording, signal);
      signal.throwIfAborted();
      if (!text.trim()) continue;
      io.heard(text);
      await io.ask(text, signal);
    }
    io.state("thinking");
    const reply = await io.reply(signal);
    signal.throwIfAborted();
    io.answered(reply);
    const speech = spokenText(reply);
    if (speech) {
      io.state("speaking");
      await io.speak(speech, signal);
      signal.throwIfAborted();
    }
  }
}

export function speechChunks(text, limit) {
  const chunks = [];
  while (text.length > limit) {
    const prefix = text.slice(0, limit);
    const sentence = [...prefix.matchAll(/[.!?](?:[”"']?)(?=\s)/g)].at(-1);
    const boundary = sentence ? sentence.index + sentence[0].length : prefix.lastIndexOf(" ");
    const end = boundary > 0 ? boundary : limit;
    chunks.push(text.slice(0, end));
    text = text.slice(end).trim();
  }
  if (text) chunks.push(text);
  return chunks;
}

const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];

function recordPhrase(stream, context, signal, cue) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let recorder;
    let chunks = [];
    let detector = speechDetector();
    let began = performance.now();
    let speech = false;
    let timer;
    let settling = false;
    const cleanup = () => {
      clearInterval(timer);
      source.disconnect();
      stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      signal.removeEventListener("abort", abort);
    };
    const fail = (error) => {
      if (settling) return;
      settling = true;
      cleanup();
      if (recorder?.state !== "inactive") recorder?.stop();
      reject(error);
    };
    const abort = () => fail(new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    const take = () => {
      chunks = [];
      const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => fail(new Error("Microphone recording failed. Check the microphone and resume."));
      recorder.onstop = () => {
        if (settling) return;
        if (!speech) { began = performance.now(); detector = speechDetector(); try { take(); } catch (error) { fail(error); } return; }
        settling = true;
        cleanup();
        resolve(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.start();
    };
    // The cue finishes before capture starts, so it cannot become a transcript.
    cue();
    timer = setTimeout(() => {
      if (signal.aborted) return;
      stream.getAudioTracks().forEach((track) => { track.enabled = true; });
      try { take(); } catch (error) { fail(error); return; }
      timer = setInterval(() => {
        if (context.state !== "running" || stream.getAudioTracks().some((track) => track.readyState === "ended" || track.muted)) {
          fail(new Error("Microphone was interrupted. Return to eleven and resume."));
          return;
        }
        analyser.getFloatTimeDomainData(samples);
        const level = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        const phase = detector.sample(level, performance.now());
        if (phase === "speech") speech = true;
        if (recorder.state !== "recording") return;
        if (phase === "done") { speech = true; recorder.stop(); }
        else if (!speech && performance.now() - began > 15_000) recorder.stop();
      }, 50);
    }, 180);
  });
}

/** In the device's own language: the person who set the phone up is the one
 *  talking to it. */
function deviceSpeech(text, signal) {
  const language = navigator.language;
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    const voice = speechSynthesis.getVoices().find((voice) => voice.lang === language && voice.localService);
    if (voice) utterance.voice = voice;
    const finish = (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      utterance.onend = utterance.onerror = null;
      error ? reject(error) : resolve();
    };
    const abort = () => { speechSynthesis.cancel(); finish(new DOMException("Cancelled", "AbortError")); };
    utterance.onend = () => finish();
    utterance.onerror = (event) => finish(new Error(`Voice playback failed (${event.error}). Choose another voice output and resume.`));
    const timer = setTimeout(() => { speechSynthesis.cancel(); finish(new Error("Voice playback timed out. Resume to speak again.")); }, 180_000);
    signal.addEventListener("abort", abort, { once: true });
    speechSynthesis.speak(utterance);
  });
}

function playAudio(context, bytes, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let source;
    const abort = () => {
      if (source) { source.onended = null; source.stop(); source.disconnect(); }
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void (async () => {
      try {
        const buffer = await context.decodeAudioData(bytes);
        signal.throwIfAborted();
        source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => { signal.removeEventListener("abort", abort); source.disconnect(); resolve(); };
        source.start();
      } catch (error) { signal.removeEventListener("abort", abort); reject(error); }
    })();
  });
}

export function openVoiceConversation({ thread, h, prefs, refresh, closed }) {
  const status = h("p", { class: "voice-status", role: "status", "aria-live": "polite" }, "Getting ready…");
  const detail = h("p", { class: "voice-detail" }, "Checking voice settings.");
  const caption = h("p", { class: "voice-caption" });
  // Chosen once, parked; in the car the only tap left is Start.
  const output = h("select", { class: "select", "aria-label": "Voice output", onchange: () => prefs.set("voice.output", output.value) });
  const start = h("button", { class: "btn btn-primary voice-action", type: "button", disabled: true, onclick: () => void begin() }, "Start conversation");
  const pause = h("button", { class: "btn voice-action", type: "button", hidden: true, onclick: () => suspend("Paused", "Resume when you are ready.") }, "Pause");
  const dialog = h("dialog", { class: "voice-dialog", "aria-label": "Voice conversation" },
    h("div", { class: "voice-content" },
      h("p", { class: "voice-workspace font-mono" }, thread.workspace),
      h("div", { class: "voice-beacon", "aria-hidden": "true" }, h("i", {}), h("i", {}), h("i", {}), h("i", {}), h("i", {})),
      status, detail, caption,
      h("div", { class: "voice-options" }, output),
      h("div", { class: "voice-actions" }, start, pause,
        h("button", { class: "btn voice-action", type: "button", onclick: () => void close() }, "End conversation")),
      h("p", { class: "voice-safety" }, "Set up while parked. Keep eleven open and the screen unlocked. Wait for the tone, then speak. Pause before switching audio devices."),
    ));
  document.body.append(dialog);
  dialog.showModal();
  let controller;
  let stream;
  let context;
  let wake;
  let ended = false;
  let generation = 0;
  // A turn the agent is still working on. Pausing leaves it running, so the
  // reply is not lost: resuming speaks it instead of listening.
  let pending = false;
  const audioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const setState = (next) => {
    dialog.dataset.state = next;
    status.textContent = ({ listening: "Listening", transcribing: "Transcribing", thinking: "Thinking", speaking: "Speaking" })[next] ?? next;
    detail.textContent = ({ listening: "Speak naturally. A pause sends your message.", transcribing: "Recognizing what you said…", thinking: "Your agent is working. The microphone is off.", speaking: "Listen to the reply. The microphone is off." })[next] ?? "";
  };
  const cue = (frequency = 660) => {
    if (context?.state !== "running") return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.045, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
    oscillator.connect(gain).connect(context.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(); oscillator.stop(context.currentTime + 0.13);
  };
  const request = async (path, payload, signal) => {
    const response = await fetch(`/api${path}`, payload === undefined ? { signal } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Voice request failed (${response.status}).`);
    }
    return response;
  };
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
  /** Polled rather than held open: a mobile connection that drops for a few
   *  seconds mid-turn costs a retry, not the reply. */
  async function awaitReply(signal) {
    let failingSince;
    for (;;) {
      let run;
      try {
        run = await (await request(`/threads/${thread.id}/run`, undefined, signal)).json();
        failingSince = undefined;
      } catch (error) {
        if (signal.aborted) throw error;
        failingSince ??= Date.now();
        if (Date.now() - failingSince > 30_000) throw new Error("Lost the connection to eleven. The agent keeps working; resume to hear the reply.");
      }
      if (run && run.status !== "running") {
        pending = false;
        refresh();
        if (run.status === "error") throw new Error(run.error || "The agent failed to answer.");
        if (run.result?.status === "stopped") throw new Error("The turn was stopped.");
        return run.result?.text ?? "";
      }
      await sleep(1000, signal);
    }
  }
  function suspend(title, message) {
    generation++;
    controller?.abort();
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    void wake?.release().catch(() => {});
    wake = undefined;
    start.hidden = false;
    pause.hidden = true;
    output.disabled = false;
    setState(title);
    detail.textContent = message;
    start.textContent = "Resume conversation";
  }
  async function close() {
    if (ended) return;
    ended = true;
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", leaving);
    window.removeEventListener("hashchange", leaving);
    suspend("Ended", "");
    await context?.close().catch(() => {});
    dialog.close(); dialog.remove();
    refresh();
    closed();
  }
  function visibility() {
    if (document.hidden && controller && !controller.signal.aborted) suspend("Paused", "eleven went into the background. Return here and resume.");
  }
  const leaving = () => void close();
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", leaving);
  window.addEventListener("hashchange", leaving);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); void close(); });
  async function begin() {
    if (ended) return;
    start.hidden = true; pause.hidden = false;
    output.disabled = true;
    controller = new AbortController();
    const { signal } = controller;
    const current = ++generation;
    const device = output.value === "device";
    try {
      context ??= new audioContext();
      const resumed = context.resume();
      // Unlock speech output in the initiating tap, before any network or permission await.
      if (device) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
      await resumed;
      signal.throwIfAborted();
      if (context.state !== "running") throw new Error("Audio is suspended. Tap Resume to enable playback.");
      setState("Connecting");
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (signal.aborted) { acquired.getTracks().forEach((track) => track.stop()); signal.throwIfAborted(); }
      stream = acquired;
      stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      try {
        const lock = await navigator.wakeLock?.request("screen");
        if (signal.aborted) void lock?.release();
        else wake = lock;
      } catch { /* Screen wake lock is optional; the foreground requirement is not. */ }
      await voiceLoop({
        state: setState,
        pending: () => pending,
        record: (signal) => recordPhrase(stream, context, signal, cue),
        transcribe: async (blob, signal) => {
          cue(440);
          const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
          const upload = await fetch(`/api/media?name=conversation.${extension}`, { method: "POST", headers: { "content-type": blob.type }, body: blob, signal });
          if (!upload.ok) throw new Error("Recording could not be uploaded. Check your connection and resume.");
          const receipt = await upload.json();
          signal.throwIfAborted();
          const response = await request("/voice/transcribe", { id: receipt.id }, signal);
          return (await response.json()).text;
        },
        heard: (text) => { caption.textContent = `You: ${text}`; },
        ask: async (text, signal) => {
          await request(`/threads/${thread.id}/voice`, { text }, signal);
          pending = true;
          refresh();
        },
        reply: awaitReply,
        answered: (text) => { caption.textContent = text; },
        speak: async (text, signal) => {
          const chunks = speechChunks(text, device ? 240 : 400);
          if (device) {
            for (const chunk of chunks) await deviceSpeech(chunk, signal);
            return;
          }
          // The next passage is synthesized while this one plays: a command that is
          // slower than playback would otherwise add its whole run to every gap.
          const synthesize = (chunk) => request("/voice/speech", { text: chunk }, signal).then((response) => response.arrayBuffer());
          let next = synthesize(chunks[0]);
          for (let index = 0; index < chunks.length; index++) {
            const audio = await next;
            next = chunks[index + 1] && synthesize(chunks[index + 1]);
            next?.catch(() => {}); // rethrown where it is awaited
            await playAudio(context, audio, signal);
          }
        },
      }, signal);
    } catch (error) {
      if (current !== generation || ended) return;
      cue(220);
      const message = error.name === "NotAllowedError" ? "Allow microphone access in your browser, then resume." : error.message;
      suspend("Paused", `${message} Nothing is resent automatically.`);
    }
  }
  void (async () => {
    try {
      if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access requires HTTPS (or localhost). Open eleven through a secure connection.");
      if (!globalThis.MediaRecorder || !audioContext) throw new Error("This browser cannot record voice. Use a current Safari, Chrome or Firefox.");
      const response = await fetch("/api/voice");
      if (!response.ok) throw new Error("Could not check voice settings. Close and try again.");
      const settings = await response.json();
      if (ended) return;
      if (!settings.transcription) throw new Error("Configure voice transcription in Settings first.");
      if (globalThis.speechSynthesis) output.append(h("option", { value: "device" }, "Device voice"));
      if (settings.speech) output.append(h("option", { value: "local" }, "Local voice"));
      if (!output.options.length) throw new Error("Configure local speech in Settings or use a browser with device voices.");
      if ([...output.options].some((option) => option.value === prefs.get("voice.output"))) output.value = prefs.get("voice.output");
      setState("Ready to talk");
      detail.textContent = "Choose how replies are spoken, then start.";
      start.disabled = false;
    } catch (error) {
      if (!ended) { setState("Voice unavailable"); detail.textContent = error.message; }
    }
  })();
  return { close };
}
