// Compare configurations of the rule judge on the fixed test set.
// A narrow agent is chosen by measurement: same messages, known verdicts.
//
// Usage: node tools/eval_judge.mjs
import { readJson, writeJson, secret } from "./lib.mjs";
import { AGENTS, makeLLM } from "../docs/pipeline.js";

const CONFIGS = [
  { label: "Haiku 5.5, no reasoning", model: "anthropic/claude-haiku-5.5", reasoning: { enabled: false }, maxTokens: 600 },
  { label: "Haiku 5.5, low reasoning", model: "anthropic/claude-haiku-5.5", reasoning: { effort: "low" }, maxTokens: 2500 },
  { label: "Sonnet 5.5, low reasoning", model: "anthropic/claude-sonnet-5.5", reasoning: { effort: "low" }, maxTokens: 2500 },
];
const RUNS = 2; // each message is judged twice, to see whether the verdict is stable

const memory = readJson("private", "memory.json");
const c = readJson("private", "cases.json").find((x) => x.kind === "judge");
const rules = memory.facts.filter((f) => f.date <= c.asof && f.cluster === "rules").map((f) => ({ id: f.id, text: f.text, provenance: f.provenance, date: f.date }));
const llm = makeLLM(secret("OPENROUTER_API_KEY"));

const results = [];
for (const cfg of CONFIGS) {
  let agreed = 0;
  let ms = 0;
  let cost = 0;
  const misses = [];
  for (const t of c.candidates) {
    for (let run = 0; run < RUNS; run++) {
      const { json, meta } = await llm({
        model: cfg.model,
        reasoning: cfg.reasoning,
        maxTokens: cfg.maxTokens,
        system: AGENTS.judge.system,
        user: JSON.stringify({ today: t.today, channel: t.channel, her_rules: rules, already_said: t.alreadySaid, message: { line: t.line } }, null, 1),
      });
      ms += meta.ms;
      cost += meta.cost || 0;
      if (json.verdict === t.expect) agreed++;
      else misses.push(`${t.label}: expected ${t.expect}, got ${json.verdict} (${json.rule}) ${json.reason}`);
    }
  }
  const total = c.candidates.length * RUNS;
  results.push({ label: cfg.label, model: cfg.model, agreed, total, avgMs: Math.round(ms / total), costPerCall: +(cost / total).toFixed(6) });
  console.log(`${cfg.label}: ${agreed}/${total} agreed, ${Math.round(ms / total)} ms and $${(cost / total).toFixed(5)} per verdict`);
  for (const m of [...new Set(misses)]) console.log(`   miss: ${m.slice(0, 300)}`);
}
writeJson({ evaluated: new Date().toISOString(), messages: c.candidates.length, runsPerMessage: RUNS, results }, "private", "judge_eval.json");
