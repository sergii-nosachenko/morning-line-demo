// Shared helpers for the local build tools. Nothing here is shipped to the site.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const at = (...parts) => path.join(ROOT, ...parts);

export const readJson = (...parts) => JSON.parse(fs.readFileSync(at(...parts), "utf8"));
export function writeJson(value, ...parts) {
  fs.mkdirSync(path.dirname(at(...parts)), { recursive: true });
  fs.writeFileSync(at(...parts), JSON.stringify(value, null, 1));
}

// The export is found by name pattern in the project root, so its file name is not written in code.
export function readExport() {
  const name = fs.readdirSync(ROOT).find((f) => /_export\.json$/.test(f));
  if (!name) throw new Error("No *_export.json file in the project root.");
  return readJson(name);
}

// Reads one value from .env without ever printing it.
export function secret(name) {
  if (process.env[name]) return process.env[name];
  const file = at(".env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  throw new Error(`${name} is not set. Put it in .env (the file is git-ignored).`);
}

// The export mixes epoch milliseconds, ISO with and without a zone, and day-first dates.
export function parseTs(raw) {
  if (typeof raw === "number") return new Date(raw);
  const s = String(raw).trim();
  let m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return new Date(/(Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`);
}

export function local(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: parts.weekday, minutes: +parts.hour * 60 + +parts.minute };
}

export const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
