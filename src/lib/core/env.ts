import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal `.env` loader.
 *
 * Next.js loads `.env` natively, but the CLI demos run under `tsx` and would
 * otherwise see none of it. A dependency for this would be overkill, and Node's
 * `--env-file` flag would have to be threaded through every npm script, so a
 * dozen lines here keeps the scripts self-contained.
 *
 * Existing environment variables always win, so `PAYMENT_ADAPTER=fake npm run …`
 * still overrides whatever the file says.
 */
export function loadDotEnv(path = ".env"): boolean {
  const absolute = resolve(process.cwd(), path);
  if (!existsSync(absolute)) return false;

  for (const rawLine of readFileSync(absolute, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes, which people add out of habit.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) process.env[key] = value;
  }
  return true;
}
