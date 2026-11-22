// A tiny static server for the docs folder, for local viewing.
// Usage: node tools/serve.mjs   then open http://localhost:8765
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { at } from "./lib.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
const root = at("docs");
const port = Number(process.env.PORT) || 8765;

http
  .createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = path.join(root, name === "/" ? "index.html" : name);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`Demo on http://localhost:${port}`));
