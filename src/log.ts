const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

const threshold: number = levels[(process.env.ELEVEN_LOG as Level) ?? "info"] ?? levels.info;

function emit(level: Level, scope: string, message: string, extra?: unknown) {
  if (levels[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 19);
  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const args: unknown[] = extra === undefined ? [line] : [line, extra];
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(...args);
}

export function logger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => emit("debug", scope, message, extra),
    info: (message: string, extra?: unknown) => emit("info", scope, message, extra),
    warn: (message: string, extra?: unknown) => emit("warn", scope, message, extra),
    error: (message: string, extra?: unknown) => emit("error", scope, message, extra),
  };
}
