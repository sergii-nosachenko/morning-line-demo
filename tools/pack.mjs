// Step 4 of the local build: encrypt everything the site needs into one file.
// Only docs/data.enc.json is committed. The passphrase stays in private/.
//
// Usage: node tools/pack.mjs
import fs from "node:fs";
import crypto from "node:crypto";
import { at, readJson, writeJson } from "./lib.mjs";
import { seal, unseal } from "../docs/vault.js";

const WORDS =
  "amber anchor apple arrow autumn basket beacon birch bridge candle canvas cedar chalk cloud copper coral cotton crane delta ember fable feather fern field flint forest garden ginger glass harbor hazel honey island ivory jasper kettle lantern lemon linen maple marble meadow mirror morning nectar north oak olive orbit paper pebble pepper pine planet quartz quiet raven river saddle sage salt silver sketch spruce stone summer thistle timber tulip umber velvet violet walnut willow window winter".split(
    " ",
  );

const phraseFile = at("private", "passphrase.txt");
if (!fs.existsSync(phraseFile)) {
  const phrase = Array.from({ length: 5 }, () => WORDS[crypto.randomInt(WORDS.length)]).join("-");
  fs.writeFileSync(phraseFile, `${phrase}\n`);
  console.log("New passphrase written to private/passphrase.txt");
}
const passphrase = fs.readFileSync(phraseFile, "utf8").trim();

const recorded = readJson("private", "recorded.json");
const bundle = {
  packed: new Date().toISOString(),
  app: readJson("private", "fixtures.json").app,
  models: recorded.models,
  memory: readJson("private", "memory.json"),
  cases: readJson("private", "cases.json"),
  runs: recorded.runs,
};

const sealed = await seal(bundle, passphrase);
writeJson(sealed, "docs", "data.enc.json");
const back = await unseal(readJson("docs", "data.enc.json"), passphrase);
console.log(`docs/data.enc.json written: ${bundle.cases.length} cases, ${bundle.memory.facts.length} facts, ${Object.keys(bundle.runs).length} recorded runs; decrypts back: ${back.cases.length === bundle.cases.length}`);
