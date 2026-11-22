// Step 3 of the local build: run every case for real and keep the result.
// The site plays this recording when no key is entered.
//
// Usage: node tools/record.mjs [caseId ...]
import fs from "node:fs";
import { at, readJson, writeJson, secret } from "./lib.mjs";
import { MODELS, makeLLM, runCase, totals } from "../docs/pipeline.js";

const memory = readJson("private", "memory.json");
const cases = readJson("private", "cases.json");
const only = process.argv.slice(2);
const recorded = fs.existsSync(at("private", "recorded.json")) ? readJson("private", "recorded.json") : { runs: {} };
const llm = makeLLM(secret("OPENROUTER_API_KEY"));

for (const c of cases) {
  if (only.length && !only.includes(c.id)) continue;
  const steps = [];
  for await (const s of runCase(c, memory, llm)) {
    steps.push(s);
    const m = s.meta ? ` [${s.meta.model} ${s.meta.ms} ms $${(s.meta.cost ?? 0).toFixed(5)}]` : "";
    const bad = s.checks.filter((k) => !k.ok).map((k) => k.text);
    console.log(`  ${c.id} ${String(steps.length).padStart(2)} ${s.stage.padEnd(15)} ${s.name}: ${s.title}${m}${bad.length ? `  !! ${bad.join(" | ")}` : ""}`);
  }
  const t = totals(steps);
  recorded.runs[c.id] = { recordedAt: new Date().toISOString(), steps };
  console.log(`${c.id}: ${t.calls} calls, ${(t.ms / 1000).toFixed(1)} s, $${(t.cost ?? 0).toFixed(4)}; on the morning path: ${t.morningCalls} calls, ${(t.morningMs / 1000).toFixed(1)} s\n`);
}

recorded.models = MODELS;
writeJson(recorded, "private", "recorded.json");
