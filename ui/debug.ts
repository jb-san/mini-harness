const DEBUG = process.env.DEBUG === "true";

export function debug(...args: unknown[]) {
  if (DEBUG) console.error("[debug]", ...args);
}
