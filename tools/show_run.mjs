// Print what the recorded run produced: every line, verdict and reminder.
// Usage: node tools/show_run.mjs
import { readJson } from "./lib.mjs";

const recorded = readJson("private", "recorded.json");
for (const [id, run] of Object.entries(recorded.runs)) {
  console.log(`\n${id} (recorded ${run.recordedAt})`);
  for (const s of run.steps) {
    const failed = s.checks.filter((k) => !k.ok).map((k) => k.text);
    if (s.name === "Line writer") console.log(`  writer, ${s.saw.stage}: ${s.said.line}${s.said.quick_action ? `  [${s.said.quick_action.prompt}: ${(s.said.quick_action.options || []).join(" / ")}]` : ""}`);
    else if (s.name === "Rule judge") console.log(`  judge: ${s.said.verdict}${s.said.rule ? ` (${s.said.rule})` : ""}`);
    else if (s.name === "Reminder writer") console.log(`  reminder: ${s.said.text}`);
    else if (s.name === "Result") console.log(`  ${s.title}`);
    if (failed.length) console.log(`     failed check: ${failed.join(" | ")}`);
  }
}
