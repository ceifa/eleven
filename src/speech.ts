import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The command reads plain text on stdin and writes a WAV to {{file}}. */
export async function synthesizeSpeech(text: string, command: string, signal: AbortSignal): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "eleven-speech-"));
  const file = join(dir, "speech.wav");
  try {
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn("bash", ["-c", command.replaceAll("{{file}}", `"${file}"`)], {
        detached: true, // its own process group, so a cancel reaches the engine the script started
        stdio: ["pipe", "ignore", "pipe"],
      });
      let errorText = "";
      let failure: Error | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch { /* already gone, close is on its way */ }
      };
      const abort = () => stop(new Error("speech cancelled"));
      const timer = setTimeout(() => stop(new Error("speech synthesis timed out")), 120_000);
      signal.addEventListener("abort", abort, { once: true });
      child.stderr.on("data", (data: Buffer) => { errorText = (errorText + data.toString()).slice(-2000); });
      child.stdin.on("error", () => {}); // A failing command can close stdin before reading the text.
      child.on("error", (error) => { failure = error; });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(errorText.trim() || `speech command exited with ${code}`));
        else resolve();
      });
      child.stdin.end(text);
    });
    if ((await stat(file)).size > 20 * 1024 * 1024) throw new Error("speech audio is too large");
    const audio = await readFile(file);
    if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("speech command must write a WAV file");
    }
    return audio;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
