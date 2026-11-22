# A morning worth opening: demo

A working sketch of one idea for a journaling app: **we do not schedule a person's morning, we answer it.**

The demo shows four cases. On the left is the phone of one person, with what she sees. On the right is every step that produced it: which agent ran, what it was given, what it returned, how long it took and what it cost.

This is a proof of an idea, built in an afternoon. It is not a product design.

## How to view it

Open the page, type the passphrase you were given, then choose:

- **Play recorded**: a real run, saved with its timings and costs. No key needed.
- **Run live**: paste an OpenRouter key and the same code calls the models in your browser. Replies differ from the recording.

Controls: `→` next step, `←` back, `space` play or pause. The slider sets how long each step stays on screen.

To run it locally:

```bash
node tools/serve.mjs
```

Then open http://localhost:8765.

## What is in the page and what is not

The site is static, so it holds **only ciphertext**: `docs/data.enc.json` is encrypted with AES-GCM, with a key derived from the passphrase (PBKDF2, 310,000 rounds). It is decrypted in the browser.

Not in this repository: the source data, the API key, the plain case files and the passphrase. The two small tools that read the source data are kept local as well, because they mirror its format.

In live mode the API key stays in the tab's memory and is sent only to `openrouter.ai`.

## How it works

```
her words ──► person memory ──► outward layer ──► search ──► world
 (inner)       facts with        general facts     sees only    public
               source, date,     about her         the outward  facts
               provenance        surroundings      layer
                    │                                             │
                    └────────────► line writer ◄─────────────────┘
                                        │
                               code checks, rule judge
                                        │
                            card inside the app (everything)
                            lock screen (world only)
```

| Who | Does what |
| --- | --- |
| Code | Mechanics and wiring: which data may go where, is a quote really in its source, length, emoji, one sentence, the handwriting confidence gate |
| Narrow agents | One judgement each, with a JSON contract: fact extractor, environment mapper, search strategist, source check, rule judge, reminder writer |
| Writer | One line, written overnight and then again when her page arrives |

Three things are guaranteed by wiring, not by asking a model nicely:

1. **The lock screen cannot leak.** The reminder writer is given only public world facts. It never receives the journal.
2. **A lookup cannot leak.** Only the `places`, `interests` and `rhythm` clusters of her memory are ever shown to the agent that builds the outward layer.
3. **A misread page is never answered.** Below the confidence gate, the page does not reach the writer.

No prompt in `docs/pipeline.js` mentions a specific person. Everything personal comes from the memory and the case data.

## Files

| Path | What |
| --- | --- |
| `docs/pipeline.js` | The pipeline: prompts, code checks, the run. Shared by the browser and the recorder |
| `docs/app.js`, `docs/style.css` | The player |
| `docs/vault.js` | Encryption and decryption |
| `docs/data.enc.json` | Encrypted memory, cases and recorded runs |
| `tools/eval_judge.mjs` | Compares rule judge configurations on a fixed test set |
| `tools/record.mjs`, `tools/pack.mjs` | Record the runs, encrypt the bundle |
| `tools/show_run.mjs` | Prints what a recorded run produced |
| `tools/serve.mjs` | A tiny local server |

## What is real and what is imagined

- **Real**: every model reply, its time and its cost; her facts and quotes; the old system's morning, taken from an event log.
- **Recorded**: the default mode plays a saved run. Nothing in it was edited by hand.
- **Imagined, and marked as such on every step**: the world data (weather, waves, listings), the later morning pages, and the history of what was already said to her.
- **Samples**: on the in-app screen, the blocks under the generated line are fixed samples, shuffled per session. They show the rest of the card and are labelled as not generated.

## What the build taught us

- The first rule judge blocked 5 of the first 8 lines, at least 4 of them wrongly. A test set of ten messages made that measurable: the small model without reasoning agreed on 16 of 20 verdicts, with a little reasoning on 20 of 20, and the larger model on 18 of 20 at fourteen times the price.
- A keyword search missed a fact, because the handwriting recognition had misread a word. The extractor read it.
- One morning costs about $0.04 here, and nearly all of it is the two writer calls, because the whole memory is sent each time. Sending only relevant facts and caching the shared prefix are the obvious levers.
