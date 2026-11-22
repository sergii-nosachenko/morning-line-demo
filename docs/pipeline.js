// The morning line pipeline. The same file runs in the browser (live mode)
// and in Node (recording), so a recorded run and a live run cannot drift apart.
//
// Division of work:
//   code   = mechanics and wiring: what data goes where, does a source exist, limits
//   agents = one narrow judgement each, with its own prompt and a JSON contract
// No prompt in this file mentions a specific person. Everything personal comes
// from the memory and the case data, which are loaded at run time.

export const MODELS = {
  fast: "anthropic/claude-haiku-5.5",
  writer: "anthropic/claude-sonnet-5.5",
};

// Narrow agents answer directly. The writer may think a little, and gets room for it,
// so that thinking can never use up the tokens meant for the answer.
const REASONING = { fast: { enabled: false }, writer: { effort: "low" } };
const MAX_TOKENS = { fast: 1500, writer: 3000 };

// Which clusters of her memory may feed the environment layer at all. Anything else
// (goals, mind, body, people, work, rules, and any new cluster) never reaches the mapper.
export const OUTWARD_CLUSTERS = ["places", "interests", "rhythm"];

export const LIMITS = { lineChars: 150, reminderChars: 60, quietBelow: 0.7 };

const API = "https://openrouter.ai/api/v1/chat/completions";

// ---------- model call ----------

export function makeLLM(apiKey) {
  // One retry: a live demo should survive a dropped connection or a malformed reply.
  return async function llm(request) {
    try {
      return await call(request);
    } catch {
      return await call(request);
    }
  };

  async function call({ model, system, user, temperature = 0, maxTokens = 1500, reasoning }) {
    const started = Date.now();
    const res = await fetch(API, {
      method: "POST",
      referrerPolicy: "no-referrer",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Morning line demo" },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        usage: { include: true },
        ...(reasoning ? { reasoning } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`${model}: ${body.error?.message || `HTTP ${res.status}`}`);
    const text = body.choices?.[0]?.message?.content || "";
    if (!text) throw new Error(`${model}: empty reply (${body.choices?.[0]?.finish_reason || "no reason given"})`);
    return {
      json: parseJson(text),
      meta: {
        model: body.model || model,
        ms: Date.now() - started,
        tokensIn: body.usage?.prompt_tokens ?? null,
        tokensOut: body.usage?.completion_tokens ?? null,
        cost: body.usage?.cost ?? null,
      },
    };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
    throw new Error("The model did not return JSON");
  }
}

// ---------- agents ----------
// sees: which rings of data the agent is given. The reminder writer is given
// only the world ring, so it cannot reveal what it never received.

export const AGENTS = {
  extractor: {
    name: "Fact extractor",
    model: "writer",
    sees: ["inner"],
    maxTokens: 6000,
    system: `You extract facts about one person from things she wrote or said. The texts can be in any language.

Each source has a ref. Entries with role "app" were written by the app, not by her: use them only as context.

Return JSON: {"facts":[{"cluster":string,"text":string,"basis":"stated"|"inferred","ref":string,"quote":string,"names":[string]}]}

- One fact = one atomic statement, written in English, in the third person.
- cluster is a short lowercase label. Use "rules" for anything she wants the app to do, never do, or how and when it may talk to her. Other usual clusters: goals, plans, people, places, work, interests, body, mind, preferences, history. Add a cluster if none fits.
- basis "stated": she said it. quote must then be an exact, verbatim substring of that source, in the original language, at most 160 characters.
- basis "inferred": your own conclusion from several things she said. Keep these few. quote may be empty.
- names: given names of people the fact mentions, otherwise an empty list.
- Do not merge different sources into one fact. Do not invent. A typo in the source stays a typo in the quote.`,
  },

  mapper: {
    name: "Environment mapper",
    model: "fast",
    sees: ["inner"],
    system: `You maintain the environment layer of one person's memory. You are given facts about her. Produce the smaller set of facts about her surroundings that outside lookups could use: place, season and climate, recurring activities, the shape of her week.

This layer is sent to outside services, so it may hold only what she would tell a stranger. No names of people, no feelings, no health, no money, no work conflicts, no goals.

Return JSON: {"facts":[{"id":"e1","cluster":string,"text":string,"precision":"exact"|"general","from":[fact ids]}]}

- precision "exact" only where a lookup needs it: a city, or a named public spot. Never a street, a building or a home address. Everything else "general".
- Keep a fact only if an outside lookup could use it. Habits at home, routines and tastes with nothing to look up stay out.
- from: the ids of the facts this came from. An environment fact without valid ids is discarded.
- Skip facts with nothing to look up outside. At most 8 facts.`,
  },

  strategist: {
    name: "Search strategist",
    model: "fast",
    sees: ["environment"],
    system: `You decide what is worth looking up in the outside world for one person's coming days. You know only general facts about her surroundings.

Return JSON: {"lookups":[{"id":"q1","what":string,"where":string,"when":string,"why":environment fact id}]}

- At most 4 lookups, the most useful first.
- Prefer facts with provenance "said" or "does". Spend no lookup on a fact with provenance "form" or "inferred" while at least two stronger facts exist: fewer lookups is fine.
- Each lookup must be answerable from public sources.`,
  },

  matcher: {
    name: "Source check",
    model: "fast",
    sees: ["environment", "world"],
    system: `You are given lookups and the public items that came back. For each item decide whether it really answers one of the lookups for the stated place and days.

Return JSON: {"findings":[{"item":item id,"lookup":lookup id,"why":string}],"dropped":[{"item":item id,"why":string}],"unanswered":[lookup ids]}

Keep an item only if it answers a lookup. An item nobody asked for is dropped.`,
  },

  writer: {
    name: "Line writer",
    model: "writer",
    sees: ["inner", "environment", "world"],
    temperature: 0.6,
    system: `You write the single line one person finds in her journaling app when she starts her day. It is a reply to what she has told the app. It is not coaching and not a summary.

Return JSON: {"line":string,"claims":[{"says":string,"ref":id}],"quick_action":null|{"kind":string,"prompt":string,"options":[string]},"why":string}

- One sentence, at most ${LIMITS.lineChars} characters, in the language given, in plain words.
- Follow every fact in the "rules" cluster exactly. They are her own instructions. When facts conflict, the later thing she said wins, what she does wins over a sign-up form, and a sign-up form (provenance "form") is the weakest.
- The line is about today: what helps her start this particular day. Mention another day only when it gives her something to look forward to or to decide now.
- One idea, not a list. Do not join unrelated things with "and".
- Build the line from her facts: what she is working towards, what she planned in her own words, what she said she needs. Prefer what is recent and unresolved.
- Every statement about her must rest on a fact id from the input. List each in claims. Use ref "page" for today's page.
- Never state a fact with provenance "inferred" as true. A fact marked quiet was read from handwriting with low confidence and may be misread. Never cite it in claims and never put its content into the line, not even reworded. It may only help you choose between things you know from other sources.
- A world finding may be used only together with something of hers, never alone, and never as the cause of how she feels. When a finding touches what she does or has planned for today or the coming days, prefer a line that uses it: it is what makes today different from yesterday.
- Do not repeat anything listed in already_said unless one of her rules allows it.
- No verdict on her day, no guilt, no counting of days kept or missed.
- stage "overnight": write the line that is ready before she wakes.
- stage "morning": a page from her has just arrived. Reply to it: keep, sharpen or replace the overnight line.
- quick_action is optional: one tap that lets her give something back. kind is free (choice, confirm, word, ...). prompt at most 40 characters, at most 3 options of at most 18 characters, in her own words where possible. Use null when nothing natural fits.
- why: one sentence on the choice you made, for the person reviewing the system.`,
  },

  judge: {
    name: "Rule judge",
    model: "fast",
    sees: ["inner"],
    // Chosen by tools/eval_judge.mjs: with a little reasoning the small model agreed on 20 of 20
    // test verdicts; without it 16 of 20; the larger model 18 of 20 at 14 times the price.
    reasoning: { effort: "low" },
    maxTokens: 2500,
    system: `You check one message against one person's own rules for how the app may talk to her.

Return JSON: {"verdict":"pass"|"block","rule":fact id|null,"reason":string}

- Judge only the line itself. A quick action is not part of the line.
- Read each rule narrowly, as she worded it. A rule is broken only by what this message does: its words, its day and time, its channel. Do not block for what a message might lead to.
- A rule about how often something may be said (once, not every day, not every morning) is judged against already_said. If nothing in already_said covers the same subject, a first mention does not break it.
- A rule about certain days, or about notifications, applies only when this message is delivered on those days or through that channel. A message delivered on another day that mentions such a day is not delivered on it.
- When two rules conflict, the later thing she said wins, and anything she said wins over a sign-up form (provenance "form").
- If no rule is clearly broken, pass. Never block for style you would have written differently.
- Block only when a specific rule is broken, and name its id. reason is one short sentence that names the words or the circumstance that break it.`,
  },

  reminder: {
    name: "Reminder writer",
    model: "fast",
    sees: ["world"],
    temperature: 0.7,
    system: `You write the lock-screen text of a notification from a journaling app. It tells someone that their line for today is waiting.

You know nothing about this person, on purpose. Anyone standing near the phone can read this text.

Return JSON: {"text":string}

- At most ${LIMITS.reminderChars} characters, one short phrase or sentence.
- Use only the public context you are given: the weekday, the weather, the light.
- It should make her curious to open, and it must reveal nothing and not pretend to know her.
- No emoji, no exclamation mark, no instructions about what she should feel or do.`,
  },
};

async function ask(llm, key, payload) {
  const spec = AGENTS[key];
  const { json, meta } = await llm({
    model: MODELS[spec.model],
    system: spec.system,
    user: JSON.stringify(payload, null, 1),
    temperature: spec.temperature ?? 0,
    maxTokens: spec.maxTokens ?? MAX_TOKENS[spec.model],
    reasoning: spec.reasoning ?? REASONING[spec.model],
  });
  return { said: json, meta };
}

// ---------- code checks ----------

const EMOJI = /\p{Extended_Pictographic}/u;
const norm = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

// A stated fact is kept only if its quote is really in the source it names.
export function verifyFacts(facts, sources) {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const kept = [];
  const rejected = [];
  for (const f of facts) {
    const src = byRef.get(f.ref);
    const stated = f.basis !== "inferred";
    if (!src || (stated && (!f.quote || !norm(src.text).includes(norm(f.quote))))) {
      rejected.push({ ...f, problem: src ? "quote not found in source" : "unknown source" });
      continue;
    }
    kept.push({
      cluster: f.cluster,
      text: f.text,
      provenance: stated ? src.provenance : "inferred",
      date: src.date,
      ref: f.ref,
      quote: stated ? f.quote : "",
      names: f.names || [],
      ...(src.confidence != null && src.confidence < LIMITS.quietBelow ? { quiet: true } : {}),
    });
  }
  return { kept, rejected };
}

function checkLine(out, known) {
  const problems = [];
  const line = String(out?.line || "");
  if (!line) problems.push("no line returned");
  if (line.length > LIMITS.lineChars) problems.push(`${line.length} characters, limit is ${LIMITS.lineChars}`);
  if (EMOJI.test(line)) problems.push("contains an emoji");
  if (/[.!?]["')\]]?\s+(?=["'(]?[A-Z])/.test(line)) problems.push("more than one sentence");
  for (const c of out?.claims || []) {
    const hit = known.get(c.ref);
    if (!hit) problems.push(`claim cites ${c.ref}, which is not in the input`);
    else if (hit.provenance === "inferred") problems.push(`claim rests on ${c.ref}, which is only inferred`);
    else if (hit.quiet) problems.push(`claim rests on ${c.ref}, which was read from handwriting with low confidence`);
  }
  if (!(out?.claims || []).length) problems.push("no sources given for the line");
  const qa = out?.quick_action;
  if (qa && (qa.options || []).some((o) => o.length > 18)) problems.push("a quick action option is too long");
  return problems;
}

function checkReminder(text, privateWords) {
  const problems = [];
  if (!text) problems.push("no text returned");
  if (text.length > LIMITS.reminderChars) problems.push(`${text.length} characters, limit is ${LIMITS.reminderChars}`);
  if (EMOJI.test(text)) problems.push("contains an emoji");
  const leaked = privateWords.filter((w) => norm(text).includes(norm(w)));
  if (leaked.length) problems.push(`contains private words: ${leaked.join(", ")}`);
  return problems;
}

// ---------- helpers ----------

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const view = (f, today) => ({
  id: f.id,
  cluster: f.cluster,
  text: f.text,
  provenance: f.provenance,
  ...(f.quote ? { quote: f.quote } : {}),
  ...(f.quiet ? { quiet: true } : {}),
  ...(f.date ? { days_ago: daysBetween(f.date, today) } : {}),
});

const step = (o) => ({ stage: "", clock: "", actor: "code", name: "", title: "", sees: [], saw: null, said: null, meta: null, checks: [], note: "", imagined: false, phone: null, ...o });

const ruleView = (f) => ({ id: f.id, text: f.text, provenance: f.provenance, date: f.date });

const count = (list, key) => list.reduce((acc, x) => ((acc[x[key]] = (acc[x[key]] || 0) + 1), acc), {});

// ---------- the run ----------

// Yields one step at a time. The player asks for the next step when the
// viewer presses Next, so in live mode every press is a real call.
export async function* runCase(c, memory, llm) {
  if (c.kind === "judge") yield* runJudgeCase(c, memory, llm);
  else yield* runMorningCase(c, memory, llm);
}

function readMemory(c, memory) {
  const facts = memory.facts.filter((f) => f.date <= c.asof).concat(c.rhythm || []);
  const rules = facts.filter((f) => f.cluster === "rules");
  const names = [...new Set(facts.flatMap((f) => f.names || []))];
  return { facts, rules, names };
}

async function* runMorningCase(c, memory, llm) {
  const today = { date: c.date, weekday: c.weekday };
  const lock = (clock, extra = {}) => ({ screen: "lock", clock, date: c.dateLabel, ...extra });

  // --- on write: the memory and its environment layer
  const { facts, rules, names } = readMemory(c, memory);
  yield step({
    stage: "On write",
    name: "Person memory",
    title: `Read the memory as it stood on ${c.asofLabel}`,
    sees: ["inner"],
    saw: { as_of: c.asof, note: "Assumed to exist: a fact memory where facts are refined, never summarised away." },
    said: { facts: facts.length, by_provenance: count(facts, "provenance"), rules: rules.map((f) => ({ id: f.id, text: f.text, quote: f.quote })) },
    phone: lock(c.nightClock, { asleep: true }),
  });

  const outward = facts.filter((f) => OUTWARD_CLUSTERS.includes(f.cluster));
  const mapped = await ask(llm, "mapper", { facts: outward.map((f) => ({ id: f.id, cluster: f.cluster, text: f.text, provenance: f.provenance })) });
  const RANK = ["said", "does", "form", "inferred"];
  let env = (mapped.said.facts || [])
    .map((e) => {
      const origins = (e.from || []).map((id) => outward.find((f) => f.id === id)).filter(Boolean);
      return origins.length ? { ...e, provenance: RANK.find((r) => origins.some((f) => f.provenance === r)) } : null;
    })
    .filter(Boolean);
  const leaking = env.filter((e) => names.some((n) => norm(e.text).includes(norm(n))));
  env = env.filter((e) => !leaking.includes(e));
  yield step({
    stage: "On write",
    actor: "agent",
    name: AGENTS.mapper.name,
    title: "Turn her facts into what may be looked up outside",
    sees: AGENTS.mapper.sees,
    saw: { facts_shown: outward.length, facts_withheld: facts.length - outward.length, clusters_allowed: OUTWARD_CLUSTERS },
    said: { environment: env },
    meta: mapped.meta,
    checks: [
      { ok: true, text: `${facts.length - outward.length} facts about goals, mind, body, people, work and rules were never shown to this agent` },
      { ok: leaking.length === 0, text: leaking.length ? `${leaking.length} fact(s) named a person and were removed by code` : "No person is named in the environment layer" },
      { ok: true, text: "Provenance of each fact is set by code from the facts it names, not by the model" },
    ],
    phone: lock(c.nightClock, { asleep: true }),
  });

  // --- overnight: look outside, then write
  const plan = await ask(llm, "strategist", { today, horizon_days: 5, environment: env });
  const proposed = plan.said.lookups || [];
  const strength = (q) => env.find((e) => e.id === q.why)?.provenance;
  const strong = proposed.filter((q) => ["said", "does"].includes(strength(q)));
  const lookups = strong.length >= 2 ? strong : proposed;
  yield step({
    stage: "Overnight",
    clock: c.nightClock,
    actor: "agent",
    name: AGENTS.strategist.name,
    title: "Decide what to look up for the coming days",
    sees: AGENTS.strategist.sees,
    saw: { today, environment: env.map((e) => ({ id: e.id, text: e.text, provenance: e.provenance })) },
    said: { lookups },
    meta: plan.meta,
    checks: [{ ok: true, text: proposed.length > lookups.length ? `${proposed.length - lookups.length} lookup(s) resting only on the sign-up form were dropped by code: what she says and does comes first` : strong.length === proposed.length ? "Every lookup rests on something she said or does" : "Fewer than two lookups rest on what she said or does, so the weaker ones are kept" }],
    phone: lock(c.nightClock, { asleep: true }),
  });

  yield step({
    stage: "Overnight",
    clock: c.nightClock,
    name: "World fetch",
    title: "Fetch public sources for those lookups",
    sees: ["world"],
    saw: { lookups: lookups.map((q) => `${q.what}, ${q.where}, ${q.when}`) },
    said: { items: c.world },
    imagined: true,
    note: "Stand-in for real sources: the world data of this day is imagined and fixed in the case file.",
    phone: lock(c.nightClock, { asleep: true }),
  });

  const match = await ask(llm, "matcher", { today, lookups, items: c.world.map((w) => ({ id: w.id, text: w.text, source: w.source })) });
  const worldIds = new Set(c.world.map((w) => w.id));
  const findings = (match.said.findings || []).filter((f) => worldIds.has(f.item)).map((f) => ({ ...c.world.find((w) => w.id === f.item), lookup: f.lookup }));
  yield step({
    stage: "Overnight",
    clock: c.nightClock,
    actor: "agent",
    name: AGENTS.matcher.name,
    title: "Keep only what answers a lookup",
    sees: AGENTS.matcher.sees,
    saw: { lookups: lookups.length, items: c.world.length },
    said: match.said,
    meta: match.meta,
    phone: lock(c.nightClock, { asleep: true }),
  });

  const pageQuiet = c.page.text != null && c.page.confidence < LIMITS.quietBelow;
  const known = new Map([...facts.map((f) => [f.id, f]), ...findings.map((w) => [w.id, { provenance: "world" }]), ["page", { provenance: "said" }]]);
  const brief = (stage, extra = {}) => ({
    today,
    stage,
    language: c.language,
    her_facts: facts.map((f) => view(f, c.date)),
    world_findings: findings.map((w) => ({ id: w.id, text: w.text })),
    already_said: c.alreadySaid || [],
    ...extra,
  });

  const written = yield* writeAndJudge(llm, { c, today, rules, known, payload: brief("overnight"), stage: "Overnight", clock: c.nightClock, fallback: null, phone: lock(c.nightClock, { asleep: true }) });
  let current = written;

  for (const beat of c.quiet || []) {
    yield step({ stage: "Morning", clock: beat.clock, name: "Nothing is sent", title: beat.title, note: beat.note, phone: lock(beat.clock, { asleep: beat.asleep }) });
  }

  // --- morning: her page arrives
  const page = c.page;
  yield step({
    stage: "Morning",
    clock: page.clock,
    name: "Pen sync",
    title: page.title,
    sees: ["inner"],
    said: { strokes: page.strokes, text: page.text || null, handwriting_confidence: page.confidence ?? null },
    imagined: !!page.imagined,
    note: page.note || "",
    phone: lock(page.clock),
  });

  if (page.text && pageQuiet) {
    yield step({
      stage: "Morning",
      clock: page.clock,
      name: "Confidence gate",
      title: "Handwriting is uncertain: the page is kept, not answered",
      checks: [{ ok: true, text: `Confidence ${page.confidence} is below the gate at ${LIMITS.quietBelow}: the writer never receives this page` }],
      note: "A misread page answered with confidence is worse than no answer. The overnight line stays. The page is stored as quiet facts, usable once a clearer page or she herself confirms them.",
      phone: lock(page.clock),
    });
  } else if (page.text) {
    yield step({
      stage: "Morning",
      clock: page.clock,
      name: "Confidence gate",
      title: "Handwriting is clear: the page may be answered directly",
      checks: [{ ok: true, text: `Confidence ${page.confidence}, the gate is at ${LIMITS.quietBelow}` }],
      phone: lock(page.clock),
    });
    current = yield* writeAndJudge(llm, {
      c,
      today,
      rules,
      known,
      payload: brief("morning", { overnight_line: written.line, page: { text: page.text } }),
      stage: "Morning",
      clock: page.clock,
      fallback: written,
      phone: lock(page.clock),
    });
  } else {
    yield step({ stage: "Morning", clock: page.clock, name: "Fallback", title: "No page text to answer: the overnight line stays", checks: [{ ok: true, text: "She never waits: a line has been ready since the night" }], phone: lock(page.clock) });
  }

  // --- outside the app
  let notification = null;
  if (c.pushEnabled) {
    const publicContext = { weekday: c.weekday, time: page.clock, world: findings.filter((w) => w.public).map((w) => w.text) };
    const rem = await ask(llm, "reminder", publicContext);
    const text = String(rem.said.text || "");
    const privateWords = [...names, ...(c.privateWords || [])];
    const problems = checkReminder(text, privateWords);
    notification = problems.length ? c.reminderFallback : text;
    yield step({
      stage: "Outside the app",
      clock: page.clock,
      actor: "agent",
      name: AGENTS.reminder.name,
      title: "Write the only text that leaves the app",
      sees: AGENTS.reminder.sees,
      saw: publicContext,
      said: rem.said,
      meta: rem.meta,
      checks: [
        { ok: true, text: "Input held 0 facts about her: the call never receives the journal" },
        { ok: !problems.length, text: problems.length ? `Rejected by code (${problems.join("; ")}), plain text used instead` : "Length, emoji and private-word checks passed" },
      ],
      phone: lock(page.clock, { push: { text: notification } }),
    });
  } else {
    yield step({
      stage: "Outside the app",
      clock: page.clock,
      name: "Nothing leaves the app",
      title: c.pushOffTitle || "Notifications are off, by her choice",
      note: c.pushOffNote || "",
      phone: lock(page.clock),
    });
  }

  yield step({
    stage: "Her morning",
    clock: c.pickupClock,
    name: "First pickup",
    title: "She picks up the phone when she is ready",
    note: "The line is behind Face ID. No sound and no badge announced it.",
    said: { line: current.line, quick_action: current.quick_action || null, sources: current.claims },
    phone: { screen: "card", clock: c.pickupClock, line: current.line, action: current.quick_action || null, origin: current.origin },
  });

  if (c.epilogue) yield* runEpilogue(c, llm);
}

// Writer, code checks and judge, with one retry and a fallback.
async function* writeAndJudge(llm, { c, today, rules, known, payload, stage, clock, fallback, phone }) {
  let feedback = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const w = await ask(llm, "writer", feedback ? { ...payload, rejected_before: feedback } : payload);
    const problems = checkLine(w.said, known);
    yield step({
      stage,
      clock,
      actor: "agent",
      name: AGENTS.writer.name,
      title: payload.stage === "morning" ? "Answer her page" : "Write the overnight line",
      sees: AGENTS.writer.sees,
      saw: { stage: payload.stage, her_facts: payload.her_facts.length, world_findings: payload.world_findings, already_said: payload.already_said, ...(payload.page ? { page: payload.page } : {}), ...(feedback ? { rejected_before: feedback } : {}) },
      said: w.said,
      meta: w.meta,
      checks: [{ ok: !problems.length, text: problems.length ? `Code check failed: ${problems.join("; ")}` : "Every claim cites a source that exists; one sentence, within length, no emoji" }],
      phone,
    });
    if (problems.length) {
      feedback = { line: w.said.line, problems };
      continue;
    }
    const j = await ask(llm, "judge", { today, channel: "card inside the app", her_rules: rules.map(ruleView), already_said: payload.already_said, message: { line: w.said.line, quick_action: w.said.quick_action } });
    const pass = j.said.verdict === "pass";
    yield step({
      stage,
      clock,
      actor: "agent",
      name: AGENTS.judge.name,
      title: "Check the line against her own rules",
      sees: AGENTS.judge.sees,
      saw: { rules: rules.length, line: w.said.line },
      said: j.said,
      meta: j.meta,
      checks: [{ ok: pass, text: pass ? "No rule broken" : `Blocked by rule ${j.said.rule}` }],
      phone,
    });
    if (pass) return { ...w.said, origin: payload.stage };
    feedback = { line: w.said.line, problems: [`breaks rule ${j.said.rule}: ${j.said.reason}`] };
  }
  const safe = fallback || { line: c.plainLine, claims: [], quick_action: null, origin: "plain" };
  yield step({ stage, clock, name: "Fallback", title: fallback ? "Two attempts failed: the overnight line stays" : "Two attempts failed: a plain line from public context is used", checks: [{ ok: false, text: "A plain line is better than one that breaks her rules or invents a fact" }], phone });
  return safe;
}

// The page the old system could not read, run through the same extractor.
async function* runEpilogue(c, llm) {
  const e = c.epilogue;
  const ex = await ask(llm, "extractor", { sources: [{ ref: e.source.ref, role: "her", text: e.source.text }] });
  const { kept, rejected } = verifyFacts(ex.said.facts || [], [e.source]);
  yield step({
    stage: "That evening",
    clock: e.clock,
    actor: "agent",
    name: AGENTS.extractor.name,
    title: e.title,
    sees: AGENTS.extractor.sees,
    saw: { language: e.language, old_system: e.oldResult },
    said: { facts: kept.map((f) => ({ cluster: f.cluster, text: f.text, quote: f.quote })) },
    meta: ex.meta,
    checks: [{ ok: rejected.length === 0, text: `${kept.length} facts kept, each quote found in the page by code${rejected.length ? `; ${rejected.length} dropped` : ""}` }],
    note: e.note,
    phone: { screen: "lock", clock: e.clock, date: c.dateLabel, asleep: true },
  });
}

// One agent, several messages, a known right answer for each.
async function* runJudgeCase(c, memory, llm) {
  const { facts, rules } = readMemory(c, memory);
  yield step({
    stage: "Her rules",
    name: "Person memory",
    title: "Read the rules she gave, in her own words",
    sees: ["inner"],
    saw: { as_of: c.asof },
    said: { rules: rules.map((f) => ({ id: f.id, text: f.text, quote: f.quote })) },
    phone: { screen: "blank", clock: c.nightClock },
  });

  let agreed = 0;
  for (const [i, t] of c.candidates.entries()) {
    const j = await ask(llm, "judge", { today: t.today, channel: t.channel, her_rules: rules.map(ruleView), already_said: t.alreadySaid, message: { line: t.line } });
    const match = j.said.verdict === t.expect;
    if (match) agreed++;
    yield step({
      stage: "Test set",
      actor: "agent",
      name: AGENTS.judge.name,
      title: `Message ${i + 1} of ${c.candidates.length}: ${t.label}`,
      sees: AGENTS.judge.sees,
      saw: { when: `${t.today.weekday} ${t.today.date}`, channel: t.channel, already_said: t.alreadySaid, line: t.line },
      said: j.said,
      meta: j.meta,
      checks: [{ ok: match, text: match ? `As expected: ${t.expect}` : `Expected ${t.expect}, the judge said ${j.said.verdict}` }],
      phone: { screen: "verdict", clock: t.clock, line: t.line, verdict: j.said.verdict, reason: j.said.reason, channel: t.channel },
    });
  }
  yield step({
    stage: "Test set",
    name: "Result",
    title: `The judge agreed with the expected verdict on ${agreed} of ${c.candidates.length} messages`,
    checks: [{ ok: agreed === c.candidates.length, text: "A narrow agent can be tested like code: fixed inputs, known answers" }],
    said: { facts_in_memory: facts.length, rules: rules.length, agreed, total: c.candidates.length, ...(c.eval ? { configurations_compared: c.eval.results.map(evalLine), each_message_judged: `${c.eval.runsPerMessage} times per configuration` } : {}) },
    phone: { screen: "blank", clock: c.nightClock },
  });
}

function evalLine(r) {
  const seconds = (r.avgMs / 1000).toFixed(1);
  const dollars = r.costPerCall.toFixed(4);
  return r.label + ": " + r.agreed + " of " + r.total + " verdicts as expected, " + seconds + " s and $" + dollars + " per verdict";
}

export function totals(steps) {
  const calls = steps.filter((s) => s.meta);
  const sum = (k) => calls.reduce((a, s) => a + (s.meta[k] || 0), 0);
  return {
    calls: calls.length,
    ms: sum("ms"),
    tokens: sum("tokensIn") + sum("tokensOut"),
    cost: calls.some((s) => s.meta.cost != null) ? sum("cost") : null,
    morningCalls: calls.filter((s) => s.stage === "Morning").length,
    morningMs: calls.filter((s) => s.stage === "Morning").reduce((a, s) => a + s.meta.ms, 0),
  };
}
