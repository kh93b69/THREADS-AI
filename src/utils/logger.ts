type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const current: Level = (process.env.LOG_LEVEL as Level) ?? "info";

function emit(level: Level, scope: string, msg: string, meta?: unknown): void {
  if (ORDER[level] < ORDER[current]) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} (${scope}) ${msg}`;
  const payload = meta === undefined ? "" : ` ${safeJson(meta)}`;
  if (level === "error") console.error(line + payload);
  else if (level === "warn") console.warn(line + payload);
  else console.log(line + payload);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit("debug", scope, m, meta),
    info: (m, meta) => emit("info", scope, m, meta),
    warn: (m, meta) => emit("warn", scope, m, meta),
    error: (m, meta) => emit("error", scope, m, meta),
  };
}
