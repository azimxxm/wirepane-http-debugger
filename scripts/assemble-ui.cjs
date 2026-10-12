#!/usr/bin/env node
// Copies the UI production build (httptoolkit-ui/dist) into the folder the desktop app ships as
// Resources/httptoolkit-ui (build/ui), and compresses its OpenAPI specs on the way. The UI has
// ~2500 of them in api/ (375 MB of JSON, from openapi-directory) and fetches one only when it
// shows a request to that API, so each is stored brotli-compressed as <name>.json.br, about a
// fourteenth of its size. httptoolkit-desktop/src/bundled-ui.ts serves them decompressed.
// Source maps, the bundle size report and the update service worker (never registered in this
// build, DISABLE_UPDATES) are left out. scripts/build-release.sh runs it after the UI build.
//
// Usage: node scripts/assemble-ui.cjs <httptoolkit-ui/dist> <output folder>
"use strict";

const os = require("os");
// Compression runs in libuv's thread pool, sized before its first use: one thread per CPU
process.env.UV_THREADPOOL_SIZE ??= String(os.availableParallelism());

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");

const brotliCompress = promisify(zlib.brotliCompress);

const [distDir, outDir] = process.argv
  .slice(2)
  .map((arg) => arg && path.resolve(arg));
if (!distDir || !outDir) {
  console.error(
    "Usage: node assemble-ui.cjs <httptoolkit-ui/dist> <output folder>",
  );
  process.exit(2);
}
if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error(
    `${distDir} has no index.html: build the UI first (npm run build)`,
  );
  process.exit(1);
}

const SPECS_DIR = "api";
const COMPRESSED_SUFFIX = ".br"; // bundled-ui.ts looks for the same suffix
const CONCURRENCY = os.availableParallelism();

// Paths relative to dist/, with forward slashes
const isLeftOut = (relativePath) =>
  relativePath.endsWith(".map") ||
  relativePath === "report.html" ||
  relativePath.startsWith("ui-update-worker.js");
const isSpec = (relativePath) =>
  relativePath.startsWith(`${SPECS_DIR}/`) && relativePath.endsWith(".json");

function listFiles(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix + entry.name;
    if (entry.isDirectory())
      return listFiles(path.join(dir, entry.name), `${relativePath}/`);
    if (!entry.isFile())
      throw new Error(`Not a plain file in the UI build: ${relativePath}`);
    return [relativePath];
  });
}

async function compressSpec(relativePath) {
  const source = await fs.promises.readFile(path.join(distDir, relativePath));
  const compressed = await brotliCompress(source, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
    },
  });
  // A broken file would only show up when someone opens that API's docs, so check each one now
  if (!zlib.brotliDecompressSync(compressed).equals(source)) {
    throw new Error(`Compressing ${relativePath} didn't round-trip`);
  }
  const target = path.join(outDir, relativePath + COMPRESSED_SUFFIX);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, compressed);
  return { before: source.length, after: compressed.length };
}

// Runs the jobs with at most `limit` in flight
async function runLimited(items, limit, job) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await job(items[index]);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

(async () => {
  const files = listFiles(distDir).filter((file) => !isLeftOut(file));
  const specs = files.filter(isSpec);
  const others = files.filter((file) => !isSpec(file));

  console.log(`Assembling the UI in ${outDir}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const file of others) {
    const target = path.join(outDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(distDir, file), target);
  }

  const started = Date.now();
  const sizes = await runLimited(specs, CONCURRENCY, compressSpec);
  const before = sizes.reduce((sum, size) => sum + size.before, 0);
  const after = sizes.reduce((sum, size) => sum + size.after, 0);
  const mb = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;
  console.log(
    `Copied ${others.length} files and compressed ${specs.length} API specs from ${mb(before)} to ` +
      `${mb(after)} in ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
