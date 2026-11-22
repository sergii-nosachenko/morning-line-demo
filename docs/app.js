// The player. Left: what she sees on her phone. Right: what happened behind it.
// It plays a recorded run, or runs the same pipeline live with a key typed on the first screen.
import { unseal } from "./vault.js";
import { makeLLM, runCase, totals } from "./pipeline.js";

const app = document.getElementById("app");
const state = {
  screen: "gate", // gate -> mode -> player
  bundle: null,
  mode: "recorded",
  llm: null,
  caseId: null,
  variant: "after",
  steps: [],
  index: -1,
  open: -1, // which step is expanded
  gen: null,
  finished: false,
  busy: false,
  busySince: 0,
  error: "",
  playing: false,
  pace: 6000, // autoplay: milliseconds each step stays on screen
};
let ticker = null;
let player = null;

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const RINGS = { inner: "Her words", environment: "Her surroundings", world: "Public world" };
const ACTORS = { agent: "Agent", code: "Code", log: "Event log" };
const human = (k) => String(k).replaceAll("_", " ");

// ---------- gate and mode ----------

function renderGate(message = "") {
  app.innerHTML = `
    <main class="door">
      <h1>A morning worth opening</h1>
      <p class="lede">A working sketch of one idea: the app does not schedule a person's morning, it answers it.</p>
      <form id="gate" class="panel">
        <label for="phrase">Passphrase</label>
        <p class="hint">The demo data is encrypted. It is decrypted here, in your browser, and goes nowhere.</p>
        <div class="row">
          <input id="phrase" type="password" autocomplete="off" spellcheck="false" placeholder="five words, with hyphens" autofocus />
          <button class="primary" type="submit">Open the demo</button>
        </div>
        <p class="error" role="alert">${esc(message)}</p>
      </form>
    </main>`;
  document.getElementById("gate").addEventListener("submit", async (e) => {
    e.preventDefault();
    const phrase = document.getElementById("phrase").value;
    if (!phrase.trim()) return;
    try {
      const sealed = await (await fetch("data.enc.json", { cache: "no-store" })).json();
      state.bundle = await unseal(sealed, phrase);
      state.screen = "mode";
      renderMode();
    } catch {
      renderGate("That passphrase does not open the data. Check the hyphens and try again.");
    }
  });
}

function renderMode(message = "") {
  const b = state.bundle;
  const when = new Date(Object.values(b.runs)[0].recordedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  app.innerHTML = `
    <main class="door">
      <h1>A morning worth opening</h1>
      <p class="lede">Four cases. On the left, the phone of one person. On the right, every step that produced what she sees.</p>
      <div class="choices">
        <section class="panel">
          <h2>Play the recorded run</h2>
          <p>Recorded on ${esc(when)}. Every model reply is real and unedited, with its time and cost.</p>
          <button class="primary" id="go-recorded">Play recorded</button>
        </section>
        <form class="panel" id="live">
          <h2>Run it live</h2>
          <p>The same code calls the models now. Replies will differ from the recording, and a line can fail a check in front of you.</p>
          <label for="key">OpenRouter API key</label>
          <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-or-..." />
          <p class="hint">Kept in this tab's memory only and sent only to openrouter.ai. It is never stored.</p>
          <button type="submit">Run live</button>
          <p class="error" role="alert">${esc(message)}</p>
        </form>
      </div>
      <p class="hint center">Models: ${esc(b.models.fast)} for the narrow agents, ${esc(b.models.writer)} for the writer.</p>
    </main>`;
  document.getElementById("go-recorded").addEventListener("click", () => start("recorded"));
  document.getElementById("live").addEventListener("submit", (e) => {
    e.preventDefault();
    const key = document.getElementById("key").value.trim();
    if (!key) return renderMode("Paste a key to run live, or play the recording.");
    state.llm = makeLLM(key);
    start("live");
  });
}

function start(mode) {
  state.mode = mode;
  state.screen = "player";
  selectCase(state.bundle.cases[0].id);
}

// ---------- flow ----------

const currentCase = () => state.bundle.cases.find((c) => c.id === state.caseId);

function selectCase(id, variant = "after") {
  stopPlaying();
  Object.assign(state, { caseId: id, variant, steps: [], index: -1, open: -1, gen: null, finished: false, busy: false, error: "" });
  renderPlayer();
  next();
}

function source() {
  const c = currentCase();
  if (state.variant === "before") return c.before;
  if (state.mode === "recorded") return state.bundle.runs[c.id].steps;
  return null; // live
}

async function next() {
  if (state.busy) return;
  if (state.index < state.steps.length - 1) return show(state.index + 1);
  if (state.finished) return stopPlaying();
  const fixed = source();
  if (fixed) {
    if (state.steps.length >= fixed.length) {
      state.finished = true;
      stopPlaying();
      return renderPlayer();
    }
    state.steps.push(fixed[state.steps.length]);
    if (state.steps.length === fixed.length) state.finished = true;
    return show(state.steps.length - 1);
  }
  // live: every press is a real call
  const c = currentCase();
  if (!state.gen) state.gen = runCase(c, state.bundle.memory, state.llm);
  state.busy = true;
  state.busySince = Date.now();
  state.error = "";
  renderPlayer();
  ticker = setInterval(updateBusy, 100);
  try {
    const { value, done } = await state.gen.next();
    if (done) state.finished = true;
    else state.steps.push(value);
  } catch (err) {
    state.error = err.message || String(err);
    state.gen = null;
    state.finished = true;
  }
  clearInterval(ticker);
  state.busy = false;
  show(state.steps.length - 1);
}

function show(i) {
  state.index = Math.max(0, Math.min(i, state.steps.length - 1));
  state.open = state.index;
  renderPlayer();
  const el = document.querySelector(".step.current");
  if (el) el.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

// Autoplay waits `state.pace` on every step, so the slider takes effect at once.
function togglePlaying() {
  if (state.playing) return stopPlaying(true);
  state.playing = true;
  renderPlayer();
  schedule();
}
function schedule() {
  clearTimeout(player);
  player = setTimeout(async () => {
    if (!state.playing) return;
    await next();
    if (state.playing) schedule();
  }, state.pace);
}
function stopPlaying(rerender = false) {
  clearTimeout(player);
  if (state.playing && rerender) {
    state.playing = false;
    renderPlayer();
  }
  state.playing = false;
}

function updateBusy() {
  const el = document.getElementById("elapsed");
  if (el) el.textContent = `${((Date.now() - state.busySince) / 1000).toFixed(1)} s`;
}

// ---------- phone ----------

// The card is more than one line. These blocks show the shell around it.
// They are fixed samples, shuffled once per session: only the line and its
// quick action come from the pipeline, and the phone says so.
const SAMPLE_BLOCKS = [
  { title: "Yesterday", body: "Close it in one tap.", chips: ["Did it", "Changed it", "Not yet"] },
  { title: "One thing today", body: "Write it by hand, or type it here.", field: true },
  { title: "Your world", body: "Sunrise 07:18. Clear until the evening." },
  { title: "Saved for lunch", body: "A 35-second reading, when you have a minute." },
  { title: "Tonight", body: "One question when you close the day." },
  { title: "This week", body: "Pages on four mornings.", week: [1, 1, 1, 0, 1, 0, 0] },
];
const sampleOrder = SAMPLE_BLOCKS.map((_, i) => i).sort(() => Math.random() - 0.5);

function renderSamples() {
  const at = state.bundle.cases.findIndex((c) => c.id === state.caseId) * 2;
  const picks = [0, 1].map((k) => SAMPLE_BLOCKS[sampleOrder[(at + k) % SAMPLE_BLOCKS.length]]);
  return `
    <div class="samples">
      <p class="samples-tag">Sample blocks, not generated</p>
      ${picks
        .map(
          (b) => `
        <article class="sample">
          <p class="sample-title">${esc(b.title)}</p>
          <p class="sample-body">${esc(b.body)}</p>
          ${b.chips ? `<p class="qa">${b.chips.map((c) => `<span>${esc(c)}</span>`).join("")}</p>` : ""}
          ${b.field ? `<p class="sample-field"></p>` : ""}
          ${b.week ? `<p class="sample-week">${b.week.map((d) => `<i class="${d ? "on" : ""}"></i>`).join("")}</p>` : ""}
        </article>`,
        )
        .join("")}
    </div>`;
}

function sky(clock) {
  const h = parseInt(clock, 10);
  if (Number.isNaN(h)) return "day";
  if (h < 6 || h >= 21) return "night";
  if (h < 9) return "dawn";
  return "day";
}

function renderPhone(step, prev) {
  const p = step?.phone || { screen: "blank", clock: "" };
  const before = prev?.phone || {};
  const appName = esc(state.bundle.app || "Journal");
  let body = "";
  let caption = "";

  if (p.screen === "lock") {
    const fresh = p.push && before.push?.text !== p.push.text;
    body = `
      <div class="lock ${sky(p.clock)} ${p.asleep ? "asleep" : ""}">
        <p class="lock-date">${esc(p.date || "")}</p>
        <p class="lock-clock">${esc(p.clock)}</p>
        ${
          p.push
            ? `<div class="banner ${fresh ? "drop" : ""} ${p.push.loud ? "loud" : ""}">
                 <p class="banner-app"><span class="dot"></span>${appName}<span class="banner-now">now</span></p>
                 <p class="banner-text">${esc(p.push.text)}</p>
               </div>`
            : ""
        }
      </div>`;
    caption = p.push ? "On the lock screen: anyone near the phone can read this." : p.asleep ? "Phone locked. Nothing on it." : "Phone locked. Nothing was sent.";
  } else if (p.screen === "card") {
    const fresh = before.screen !== "card" || before.line !== p.line;
    body = `
      <div class="inapp">
        <p class="inapp-bar"><span>${esc(p.clock)}</span><span>${appName}</span></p>
        <p class="inapp-day">Today</p>
        <article class="line-card ${fresh ? "rise" : ""}">
          <p class="line-text">${esc(p.line)}</p>
          ${p.action ? `<p class="qa-prompt">${esc(p.action.prompt || "")}</p><p class="qa">${(p.action.options || []).map((o) => `<span>${esc(o)}</span>`).join("")}</p>` : ""}
          <p class="origin">${p.origin === "morning" ? "Answering this morning's page" : p.origin === "plain" ? "Plain line from public context" : "Ready since last night"}</p>
        </article>
        ${renderSamples()}
      </div>`;
    caption = "Inside the app, behind Face ID. The line is generated. The blocks under it are fixed samples of the rest of the card.";
  } else if (p.screen === "old") {
    body = `
      <div class="inapp old">
        <p class="inapp-bar"><span>${esc(p.clock)}</span><span>${appName}</span></p>
        <article class="line-card rise">
          <p class="old-title">${esc(p.title)}</p>
          <p class="line-text">${esc(p.sub)}</p>
          <p class="old-timer">60 s</p>
        </article>
      </div>`;
    caption = "The old morning exercise, opened from the notification.";
  } else if (p.screen === "verdict") {
    const pass = p.verdict === "pass";
    body = `
      <div class="inapp judge">
        <p class="inapp-bar"><span>${esc(p.clock || "")}</span><span>Candidate message</span></p>
        <p class="channel">${esc(p.channel)}</p>
        <article class="line-card rise ${pass ? "is-pass" : "is-block"}">
          <p class="line-text">${esc(p.line)}</p>
          <p class="stamp">${pass ? "Passes her rules" : "Blocked"}</p>
        </article>
        <p class="reason">${esc(p.reason || "")}</p>
      </div>`;
    caption = pass ? "This message may be shown." : "She never sees this message.";
  } else {
    body = `<div class="lock night asleep"><p class="lock-clock small">No screen in this step</p></div>`;
    caption = "Nothing reaches the phone here.";
  }
  return `<div class="phone"><div class="screen">${body}</div></div><p class="phone-caption">${caption}</p>`;
}

// ---------- trace ----------

function renderValue(v, key = "") {
  if (v == null) return `<span class="nil">nothing</span>`;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v !== "object") {
    const text = esc(v);
    if (key === "line" || key === "text" || key === "body") return `<span class="quote">${text}</span>`;
    if (key === "verdict") return `<span class="verdict ${v === "pass" ? "ok" : "bad"}">${text}</span>`;
    return text;
  }
  if (Array.isArray(v)) {
    if (!v.length) return `<span class="nil">none</span>`;
    if (v.every((x) => typeof x !== "object")) return `<ul class="plain">${v.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    return `<ul class="items">${v.map((x) => `<li>${renderObject(x)}</li>`).join("")}</ul>`;
  }
  return renderObject(v);
}

function renderObject(o) {
  const lead = o.id || o.item || o.ref;
  const tags = ["provenance", "precision", "cluster", "source", "lookup", "why"].filter((k) => typeof o[k] === "string" && k !== "why");
  const main = o.text ?? o.what ?? o.says ?? o.said ?? null;
  // compact one-line form for the common shapes (facts, lookups, findings, claims)
  if (main && Object.keys(o).every((k) => ["id", "item", "ref", "text", "what", "says", "said", "where", "when", "why", "date", "from", "quote", "names", "public", "assumed", ...tags].includes(k))) {
    const extra = [o.where, o.when].filter(Boolean).join(", ");
    return `
      <span class="fact">
        ${lead ? `<code>${esc(lead)}</code>` : ""}
        <span>${esc(main)}${extra ? ` <em>${esc(extra)}</em>` : ""}${o.quote ? ` <q>${esc(o.quote)}</q>` : ""}</span>
        ${tags.map((k) => `<i class="tag t-${esc(o[k])}">${esc(o[k])}</i>`).join("")}
        ${o.assumed ? `<i class="tag t-imagined">assumed</i>` : ""}
        ${o.from ? `<i class="tag">from ${esc(o.from.join(", "))}</i>` : ""}
        ${typeof o.why === "string" && o.why.length < 8 ? `<i class="tag">for ${esc(o.why)}</i>` : ""}
      </span>`;
  }
  return `<dl>${Object.entries(o)
    .map(([k, val]) => `<div><dt>${esc(human(k))}</dt><dd>${renderValue(val, k)}</dd></div>`)
    .join("")}</dl>`;
}

function metaLine(m) {
  if (!m) return "";
  const cost = m.cost != null ? `$${m.cost.toFixed(m.cost < 0.001 ? 5 : 4)}` : "cost n/a";
  return `<p class="meta"><span>${esc(m.model.replace("anthropic/", ""))}</span><span>${(m.ms / 1000).toFixed(1)} s</span><span>${m.tokensIn ?? "?"} in, ${m.tokensOut ?? "?"} out</span><span>${cost}</span></p>`;
}

function renderStep(s, i) {
  const current = i === state.index;
  const open = i === state.open;
  const failed = s.checks.some((k) => !k.ok);
  const short = s.meta ? `${(s.meta.ms / 1000).toFixed(1)} s` : "";
  return `
    <li class="step a-${s.actor} ${current ? "current" : ""} ${open ? "open" : ""} ${failed ? "has-fail" : ""}">
      <button class="step-head" data-step="${i}" aria-expanded="${open}">
        <span class="when">${esc(s.clock || "")}</span>
        <span class="who">${esc(ACTORS[s.actor])}</span>
        <span class="what"><b>${esc(s.name)}</b> ${esc(s.title)}</span>
        <span class="took">${short}</span>
      </button>
      ${
        open
          ? `<div class="step-body">
              ${s.sees.length ? `<p class="sees">Sees ${s.sees.map((r) => `<span class="ring r-${r}">${RINGS[r]}</span>`).join("")}${s.imagined ? `<span class="ring r-imagined">Imagined data</span>` : ""}</p>` : s.imagined ? `<p class="sees"><span class="ring r-imagined">Imagined data</span></p>` : ""}
              ${s.saw ? `<section><h4>Was given</h4>${renderValue(s.saw)}</section>` : ""}
              ${s.said ? `<section><h4>${s.actor === "log" ? "Recorded" : "Returned"}</h4>${renderValue(s.said)}</section>` : ""}
              ${s.checks.length ? `<ul class="checks">${s.checks.map((k) => `<li class="${k.ok ? "ok" : "bad"}">${esc(k.text)}</li>`).join("")}</ul>` : ""}
              ${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}
              ${metaLine(s.meta)}
            </div>`
          : ""
      }
    </li>`;
}

function renderTrace() {
  let stage = null;
  let html = "";
  state.steps.forEach((s, i) => {
    if (s.stage !== stage) {
      stage = s.stage;
      html += `<li class="stage">${esc(stage)}</li>`;
    }
    html += renderStep(s, i);
  });
  if (state.busy) html += `<li class="step busy"><div class="step-head"><span class="when"></span><span class="who">Agent</span><span class="what"><b>Calling the model</b> waiting for the reply</span><span class="took" id="elapsed">0.0 s</span></div></li>`;
  if (state.error) html += `<li class="step failed"><div class="step-body"><p class="error">The live run stopped: ${esc(state.error)}</p><p class="note">Restart this case, or reload the page and play the recorded run.</p></div></li>`;
  return html;
}

function renderPlayer() {
  const b = state.bundle;
  const c = currentCase();
  const step = state.steps[state.index];
  const prev = state.steps[state.index - 1];
  const t = totals(state.steps.slice(0, state.index + 1));
  const fixed = source();
  const atEnd = state.finished && state.index === state.steps.length - 1;
  const scroll = document.querySelector(".trace")?.scrollTop;

  app.innerHTML = `
    <header class="top">
      <div class="brand"><strong>A morning worth opening</strong><span class="mode ${state.mode}">${state.mode === "live" ? "Live run" : "Recorded run"}</span></div>
      <nav class="tabs" aria-label="Cases">
        ${b.cases.map((x) => `<button data-case="${x.id}" class="${x.id === c.id ? "on" : ""}">${esc(x.tab)}</button>`).join("")}
      </nav>
    </header>
    <section class="case">
      <div>
        <h1>${esc(c.title)}</h1>
        <p class="proves">${esc(c.proves)}</p>
        <p class="data">${esc(c.data)}</p>
      </div>
      ${
        c.before
          ? `<div class="switch" role="group" aria-label="System">
               <button data-variant="before" class="${state.variant === "before" ? "on" : ""}">What happened</button>
               <button data-variant="after" class="${state.variant === "after" ? "on" : ""}">What we would do</button>
             </div>`
          : ""
      }
    </section>
    <main class="stage-grid">
      <aside class="phone-col">${renderPhone(step, prev)}</aside>
      <ol class="trace">${renderTrace()}</ol>
    </main>
    <footer class="bar">
      <div class="controls">
        <button id="back" ${state.index <= 0 || state.busy ? "disabled" : ""}>Back</button>
        <button id="next" class="primary" ${atEnd || state.busy ? "disabled" : ""}>${state.busy ? "Running" : atEnd ? "End of case" : "Next step"}</button>
        ${
          fixed
            ? `<button id="play" class="play ${state.playing ? "on" : ""}" ${atEnd ? "disabled" : ""}>${state.playing ? "Pause" : "Play"}${state.playing && !atEnd ? `<span class="countdown" style="animation-duration:${state.pace}ms"></span>` : ""}</button>
               <label class="pace">Each step stays <input id="pace" type="range" min="2" max="15" step="1" value="${state.pace / 1000}" /> <output id="pace-out">${state.pace / 1000} s</output></label>`
            : ""
        }
        <button id="restart" ${state.busy ? "disabled" : ""}>Restart</button>
        <span class="count">Step ${state.index + 1}${fixed ? ` of ${fixed.length}` : ""}</span>
      </div>
      <dl class="totals">
        <div><dt>Model calls</dt><dd>${t.calls}</dd></div>
        <div><dt>Model time</dt><dd>${(t.ms / 1000).toFixed(1)} s</dd></div>
        <div><dt>Cost</dt><dd>${t.cost != null ? `$${t.cost.toFixed(4)}` : "n/a"}</dd></div>
        <div><dt>While she waits</dt><dd>${t.morningCalls} calls, ${(t.morningMs / 1000).toFixed(1)} s</dd></div>
      </dl>
    </footer>`;

  if (scroll != null) document.querySelector(".trace").scrollTop = scroll;
  app.querySelectorAll("[data-case]").forEach((el) => el.addEventListener("click", () => selectCase(el.dataset.case)));
  app.querySelectorAll("[data-variant]").forEach((el) => el.addEventListener("click", () => selectCase(c.id, el.dataset.variant)));
  app.querySelectorAll("[data-step]").forEach((el) =>
    el.addEventListener("click", () => {
      const i = +el.dataset.step;
      state.open = state.open === i ? -1 : i;
      state.index = i;
      renderPlayer();
    }),
  );
  document.getElementById("back").addEventListener("click", () => (stopPlaying(), show(state.index - 1)));
  document.getElementById("next").addEventListener("click", () => (stopPlaying(), next()));
  document.getElementById("restart").addEventListener("click", () => selectCase(c.id, state.variant));
  document.getElementById("play")?.addEventListener("click", togglePlaying);
  document.getElementById("pace")?.addEventListener("input", (e) => {
    state.pace = +e.target.value * 1000;
    document.getElementById("pace-out").textContent = `${e.target.value} s`;
    if (state.playing) schedule(); // restart the wait with the new pace
    const bar = document.querySelector(".countdown");
    if (bar) {
      bar.style.animation = "none";
      void bar.offsetWidth;
      bar.style.animation = "";
      bar.style.animationDuration = `${state.pace}ms`;
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (state.screen !== "player" || e.target.matches("input")) return;
  if (e.key === "ArrowRight") (stopPlaying(), next());
  if (e.key === "ArrowLeft") (stopPlaying(), show(state.index - 1));
  if (e.key === " " && source() && !e.target.closest("button")) (e.preventDefault(), togglePlaying());
});

renderGate();
