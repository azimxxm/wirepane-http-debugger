#!/usr/bin/env node
// Writes a package.json and a package-lock.json into a staging folder that install only what
// Wirepane's server release ships in node_modules: the server's oclif.dependenciesToPackage (oclif
// itself and the native modules the bundle can't hold) and everything those need, at exactly the
// versions and integrity hashes in httptoolkit-server/package-lock.json, in the same folder layout.
// scripts/build-server.sh then runs `npm ci` there with the release's own Node.js. Upstream's
// pack.ts does the same by cutting package.json down to those dependencies.
//
// Every one of them is a required dependency there, so a package that doesn't install fails the
// build: tls-impersonate, an optional dependency of the server, was silently left out before.
//
// Prints the packages that have install scripts (native modules), one per line, for
// build-server.sh to check that it knows how to get each one's binary for every target.
//
// Usage: node scripts/stage-server-deps.cjs <httptoolkit-server folder> <staging folder>
"use strict";

const fs = require("fs");
const path = require("path");

const [serverDir, stagingDir] = process.argv
  .slice(2)
  .map((arg) => arg && path.resolve(arg));
if (!serverDir || !stagingDir) {
  console.error(
    "Usage: node stage-server-deps.cjs <httptoolkit-server folder> <staging folder>",
  );
  process.exit(2);
}

const fail = (message) => {
  throw new Error(message);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const pjson = readJson(path.join(serverDir, "package.json"));
const lock = readJson(path.join(serverDir, "package-lock.json"));
if (!lock.packages || lock.lockfileVersion < 2) {
  fail(
    "httptoolkit-server/package-lock.json has no `packages` (lockfile version 2 or 3 needed)",
  );
}

// npm's lookup in the lockfile's tree: the package's own node_modules, then each parent's, up
// to the top-level node_modules
function resolveInLock(fromLocation, name) {
  let base = fromLocation;
  for (;;) {
    const candidate = base
      ? `${base}/node_modules/${name}`
      : `node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!base) return undefined;
    const parentEnd = base.lastIndexOf("/node_modules/");
    base = parentEnd === -1 ? "" : base.slice(0, parentEnd);
  }
}

const roots = pjson.oclif.dependenciesToPackage;
const needed = new Set();
const queue = roots.map((name) => {
  const location = resolveInLock("", name);
  if (!location) fail(`${name} is not in httptoolkit-server/package-lock.json`);
  return location;
});

while (queue.length > 0) {
  const location = queue.shift();
  if (needed.has(location)) continue;
  const entry = lock.packages[location];
  if (entry.link) {
    fail(
      `${location} is a link (a file: dependency?), and a release can't ship links`,
    );
  }
  needed.add(location);

  const optional = entry.optionalDependencies ?? {};
  for (const name of Object.keys({ ...entry.dependencies, ...optional })) {
    const dependency = resolveInLock(location, name);
    if (dependency) queue.push(dependency);
    else if (!(name in optional))
      fail(`${location} needs ${name}, which isn't in the lockfile`);
  }
  // Peers come from the parent package. They're only part of the release if installed.
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    const dependency = resolveInLock(location, name);
    if (dependency) queue.push(dependency);
  }
}

const rootLocations = new Set(roots.map((name) => resolveInLock("", name)));
const dependencies = Object.fromEntries(
  roots.map((name) => [name, lock.packages[`node_modules/${name}`].version]),
);

const stagedPackages = {};
for (const location of [...needed].sort()) {
  const entry = { ...lock.packages[location] };
  // Everything here is shipped, so nothing is a dev dependency, and the top-level ones are
  // required: npm would drop an optional one quietly if it failed to install
  delete entry.dev;
  if (rootLocations.has(location)) {
    delete entry.optional;
    delete entry.devOptional;
  }
  stagedPackages[location] = entry;
}

const name = "wirepane-server-release-dependencies";
fs.mkdirSync(stagingDir, { recursive: true });
fs.writeFileSync(
  path.join(stagingDir, "package.json"),
  JSON.stringify(
    {
      name,
      version: pjson.version,
      private: true,
      description:
        "The node_modules of Wirepane's server release (scripts/stage-server-deps.cjs)",
      dependencies,
      // The lockfile was made with these (e.g. registry-js gets a newer prebuild-install), and
      // npm ci refuses a lockfile that doesn't match them
      ...(pjson.overrides ? { overrides: pjson.overrides } : {}),
    },
    null,
    2,
  ) + "\n",
);
fs.writeFileSync(
  path.join(stagingDir, "package-lock.json"),
  JSON.stringify(
    {
      name,
      version: pjson.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name, version: pjson.version, dependencies },
        ...stagedPackages,
      },
    },
    null,
    2,
  ) + "\n",
);

for (const location of Object.keys(stagedPackages)) {
  if (stagedPackages[location].hasInstallScript) {
    console.log(location.slice(location.lastIndexOf("node_modules/") + 13));
  }
}
