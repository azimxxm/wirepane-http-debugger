#!/usr/bin/env node
// Lays out Wirepane's server release: the folder the desktop app ships as Resources/httptoolkit-server.
// scripts/build-server.sh runs it once lib/, oclif.manifest.json and bundle/ are built. It's the
// layout of the official darwin-arm64 tarball (upstream's pack.ts + oclif-dev pack), but made from
// this repo, with nothing downloaded:
//   bin/           run (oclif's entry point), node (Node.js), httptoolkit-server (our launcher)
//   bundle/        the rspack bundle: the server and nearly all of its dependencies, Bruno included
//   lib/           the oclif commands, which load the bundle
//   node_modules/  only oclif.dependenciesToPackage (oclif itself, native modules) and what they
//                  need, copied as plain files from httptoolkit-server/node_modules (built for this Mac)
//   overrides/, nss/darwin/, oclif.manifest.json, and package.json with its dependencies cut down
//   to those, like pack.ts does
//
// Usage: node scripts/assemble-server.cjs <httptoolkit-server folder> <output folder> <Node.js folder>
// The Node.js folder holds bin/node and its LICENSE.
"use strict";

const fs = require("fs");
const path = require("path");

const [serverDir, outDir, nodeDir] = process.argv
  .slice(2)
  .map((arg) => arg && path.resolve(arg));
if (!serverDir || !outDir || !nodeDir) {
  console.error(
    "Usage: node assemble-server.cjs <httptoolkit-server folder> <output folder> <Node.js folder>",
  );
  process.exit(2);
}

// Oclif's launcher would run a newer server from ~/.local/share/<dirname>/client instead of this one
// if it found one, and that folder can hold the official HTTP Toolkit app's downloaded updates. Ours
// always runs the server it sits in.
const LAUNCHER = `#!/bin/sh
# Starts this Wirepane server with the Node.js next to it (written by scripts/assemble-server.cjs).
# Unlike oclif's launcher, it never switches to a server downloaded into ~/.local/share/*/client.
set -e
script="$0"
while [ -h "$script" ]; do
    link="$(readlink "$script")"
    case "$link" in
        /*) script="$link" ;;
        *) script="$(dirname "$script")/$link" ;;
    esac
done
dir="$(cd -P "$(dirname "$script")" && pwd)"
# Marks a packaged release (IS_PROD_BUILD in src/constants.ts): the server runs its bundle and
# only accepts requests from the UI bundled in the app
HTTPTOOLKIT_SERVER_BINPATH="$dir/httptoolkit-server"
export HTTPTOOLKIT_SERVER_BINPATH
exec "$dir/node" "$dir/run" "$@"
`;

const fail = (message) => {
  throw new Error(message);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const relativeParts = (from, to) => path.relative(from, to).split(path.sep);

// Copies a folder or file. A release can't contain links: they'd point into this repo, which users
// don't have, and they break the app's code signature.
function copy(from, to, skip = () => false) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      if (skip(src)) return false;
      if (fs.lstatSync(src).isSymbolicLink())
        fail(`Unexpected link in the server release: ${src}`);
      return true;
    },
  });
}

const isSourceMap = (file) => file.endsWith(".map");

for (const required of [
  "bundle/index.js",
  "lib/commands/start.js",
  "oclif.manifest.json",
]) {
  if (!fs.existsSync(path.join(serverDir, required))) {
    fail(
      `${required} is missing in ${serverDir}. scripts/build-server.sh builds it first.`,
    );
  }
}
if (!fs.existsSync(path.join(serverDir, "overrides", "js", "node_modules"))) {
  fail(
    "overrides/js/node_modules is missing (made by the server's prepare script). Run ./setup.sh",
  );
}
const nodeBinary = path.join(nodeDir, "bin", "node");
if (!fs.existsSync(nodeBinary)) fail(`No Node.js binary at ${nodeBinary}`);

// Node's module lookup: the node_modules folders from fromDir up to the server folder
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    if (dir === serverDir || dir === path.dirname(dir)) return undefined;
  }
}

// Collects the folders of the given packages and of everything they depend on
function collectPackages(roots, optionalRoots) {
  const found = new Map(); // folder -> package.json
  const queue = [];

  for (const name of roots) {
    const dir = resolvePackage(name, serverDir);
    if (dir) queue.push(dir);
    else if (optionalRoots.has(name))
      console.warn(
        `WARNING: leaving out ${name}, an optional dependency npm didn't install here (see its "engines" and "os"; ./setup.sh installs it once they match)`,
      );
    else
      fail(
        `${name} is not installed in ${serverDir}/node_modules. Run ./setup.sh`,
      );
  }

  while (queue.length > 0) {
    const dir = queue.shift();
    if (found.has(dir)) continue;
    if (fs.lstatSync(dir).isSymbolicLink()) {
      fail(
        `${dir} is a link (a file: dependency?), and a release can't ship links`,
      );
    }

    const pkg = readJson(path.join(dir, "package.json"));
    found.set(dir, pkg);

    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    for (const name of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    })) {
      const depDir = resolvePackage(name, dir);
      if (depDir) queue.push(depDir);
      else if (!optional.has(name))
        fail(`${pkg.name} needs ${name}, which isn't installed`);
    }
    // Peers come from the parent package. They're only part of the release if installed.
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
      const depDir = resolvePackage(name, dir);
      if (depDir) queue.push(depDir);
    }
  }

  return found;
}

const pjson = readJson(path.join(serverDir, "package.json"));
const roots = pjson.oclif.dependenciesToPackage;
const packages = collectPackages(
  roots,
  new Set(Object.keys(pjson.optionalDependencies ?? {})),
);

console.log(`Assembling the server release in ${outDir}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "bin"), { recursive: true });

// bin/: oclif's entry point, Node.js (with its license) and our launcher
fs.copyFileSync(
  path.join(serverDir, "bin", "run"),
  path.join(outDir, "bin", "run"),
);
fs.copyFileSync(nodeBinary, path.join(outDir, "bin", "node"));
fs.copyFileSync(
  path.join(nodeDir, "LICENSE"),
  path.join(outDir, "bin", "node-LICENSE"),
);
fs.writeFileSync(path.join(outDir, "bin", "httptoolkit-server"), LAUNCHER);
for (const bin of ["run", "node", "httptoolkit-server"])
  fs.chmodSync(path.join(outDir, "bin", bin), 0o755);

// The bundle (all chunks, Bruno's lazily loaded ones too) and the compiled commands. Source maps
// aren't shipped, as in upstream's releases.
copy(path.join(serverDir, "bundle"), path.join(outDir, "bundle"), isSourceMap);
copy(path.join(serverDir, "lib"), path.join(outDir, "lib"), isSourceMap);

// Interception scripts. overrides/webextension/config is runtime config from old dev runs, and
// node_modules/.bin only holds npm's command links, which nothing runs.
const webExtensionConfig = path.join(
  serverDir,
  "overrides",
  "webextension",
  "config",
);
copy(
  path.join(serverDir, "overrides"),
  path.join(outDir, "overrides"),
  (src) => src === webExtensionConfig || path.basename(src) === ".bin",
);

// NSS tools for Firefox's certificate database: only the macOS ones, with their license
fs.mkdirSync(path.join(outDir, "nss"));
copy(path.join(serverDir, "nss", "darwin"), path.join(outDir, "nss", "darwin"));
for (const file of ["LICENSE", "README.md"]) {
  fs.copyFileSync(
    path.join(serverDir, "nss", file),
    path.join(outDir, "nss", file),
  );
}

for (const file of ["oclif.manifest.json", "LICENSE"]) {
  fs.copyFileSync(path.join(serverDir, file), path.join(outDir, file));
}

// node_modules: each package as a plain copy. Nested node_modules folders are copied as packages
// of their own, and only when something needs them.
for (const dir of packages.keys()) {
  copy(dir, path.join(outDir, path.relative(serverDir, dir)), (src) => {
    const inner = relativeParts(dir, src);
    return (
      inner.includes("node_modules") ||
      // Build-time links to python left by node-gyp (upstream's setup-server.ts drops them too)
      inner.includes("node_gyp_bins") ||
      // pack.ts' postinstall: tls-impersonate always uses its prebuilds, not a local build
      (path.basename(dir) === "tls-impersonate" && inner[0] === "build")
    );
  });
}

// package.json lists only the shipped dependencies, at their installed versions
const releaseJson = { ...pjson };
releaseJson.dependencies = {};
for (const name of roots) {
  const dir = resolvePackage(name, serverDir);
  if (dir) releaseJson.dependencies[name] = packages.get(dir).version;
}
for (const key of [
  "devDependencies",
  "optionalDependencies",
  "scripts",
  "overrides",
  "mocha",
]) {
  delete releaseJson[key];
}
fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(releaseJson, null, 2) + "\n",
);

console.log(`Copied ${packages.size} packages into node_modules`);
