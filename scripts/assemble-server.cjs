#!/usr/bin/env node
// Lays out Wirepane's server release for one target: the folder the desktop app ships as
// Resources/httptoolkit-server. scripts/build-server.sh runs it once lib/, oclif.manifest.json and
// bundle/ are built and the release's node_modules are installed (scripts/stage-server-deps.cjs).
// It's the layout of the official release tarballs (upstream's pack.ts + oclif-dev pack), but
// made from this repo:
//   bin/           run (oclif's entry point), node or node.exe (Node.js), and our launcher:
//                  httptoolkit-server (a shell script) or httptoolkit-server.cmd on Windows
//   bundle/        the rspack bundle: the server and nearly all of its dependencies, Bruno included
//   lib/           the oclif commands, which load the bundle
//   node_modules/  only oclif.dependenciesToPackage (oclif itself, native modules) and what they
//                  need, from the staging folder, with each native module's binary for the target
//   overrides/, nss/<os>/, oclif.manifest.json, and package.json with its dependencies cut down
//   to those, like pack.ts does
// It ends by checking that every native binary in the release is built for the target.
//
// Usage: node scripts/assemble-server.cjs <httptoolkit-server folder> <output folder>
//          <Node.js folder> <target> <staging folder>
// The Node.js folder is the extracted nodejs.org download for the target. The target is
// darwin-arm64, linux-x64 or win32-x64. The staging folder holds the installed node_modules.
"use strict";

const fs = require("fs");
const path = require("path");

const [serverDir, outDir, nodeDir, target, stagingDir] = process.argv
  .slice(2)
  .map((arg, index) => (arg && index !== 3 ? path.resolve(arg) : arg));
if (!serverDir || !outDir || !nodeDir || !target || !stagingDir) {
  console.error(
    "Usage: node assemble-server.cjs <httptoolkit-server folder> <output folder> <Node.js folder> <target> <staging folder>",
  );
  process.exit(2);
}

const [targetOs, targetArch] = target.split("-");
if (!["darwin", "linux", "win32"].includes(targetOs) || !targetArch) {
  console.error(`Unknown target ${target}, expected e.g. darwin-arm64`);
  process.exit(2);
}
const isWindows = targetOs === "win32";

// Oclif's launcher would run a newer server from ~/.local/share/<dirname>/client instead of this one
// if it found one, and that folder can hold the official HTTP Toolkit app's downloaded updates. Ours
// always runs the server it sits in.
const UNIX_LAUNCHER = `#!/bin/sh
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

// The same for Windows, where the desktop app runs bin\httptoolkit-server.cmd. Oclif's version
// would switch to %LOCALAPPDATA%\httptoolkit-server\client. CRLF line endings, as cmd.exe expects.
const WINDOWS_LAUNCHER = `@echo off
rem Starts this Wirepane server with the Node.js next to it (written by scripts/assemble-server.cjs).
rem Unlike oclif's launcher, it never switches to a server downloaded into %LOCALAPPDATA%.
setlocal
rem Marks a packaged release (IS_PROD_BUILD in src/constants.ts): the server runs its bundle and
rem only accepts requests from the UI bundled in the app
set "HTTPTOOLKIT_SERVER_BINPATH=%~dp0httptoolkit-server.cmd"
"%~dp0node.exe" "%~dp0run" %*
`.replace(/\n/g, "\r\n");

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
const nodeBinary = isWindows
  ? path.join(nodeDir, "node.exe")
  : path.join(nodeDir, "bin", "node");
if (!fs.existsSync(nodeBinary)) fail(`No Node.js binary at ${nodeBinary}`);

// Node's module lookup: the node_modules folders from fromDir up to the staging folder
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    if (dir === stagingDir || dir === path.dirname(dir)) return undefined;
  }
}

// Collects the folders of the given packages and of everything they depend on
function collectPackages(roots) {
  const found = new Map(); // folder -> package.json
  const queue = roots.map((name) => {
    const dir = resolvePackage(name, stagingDir);
    if (!dir) {
      fail(
        `${name} is not installed in ${stagingDir}/node_modules (scripts/build-server.sh installs it)`,
      );
    }
    return dir;
  });

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

// "darwin-arm64", "win32-x64", "darwin-x64+arm64": prebuilds/ folder names (node-gyp-build)
const prebuildMatchesTarget = (folderName) => {
  const [os, archs = ""] = folderName.split("-");
  return os === targetOs && archs.split("+").includes(targetArch);
};

// Native modules that load their binary only on Windows (they check process.platform first)
const WINDOWS_ONLY_MODULES = new Set(["registry-js", "win-version-info"]);

// Leaves out the native binaries a package doesn't use on the target
function skipNativeFiles(packageDir, inner) {
  const name = path.basename(packageDir);
  const hasPrebuilds = fs.existsSync(path.join(packageDir, "prebuilds"));
  if (inner[0] === "build") {
    // node-gyp-build prefers build/ over prebuilds/, and a build/ is made for the machine that
    // installed the package, not the target (upstream's pack.ts drops tls-impersonate's too)
    if (hasPrebuilds) return true;
    if (!isWindows && WINDOWS_ONLY_MODULES.has(name)) return true;
  }
  // Only the target's prebuilt binaries: the others are dead weight that fails the check below
  if (inner[0] === "prebuilds" && inner.length >= 2)
    return !prebuildMatchesTarget(inner[1]);
  return false;
}

// What a native binary was built for, from its header: ELF (Linux), Mach-O (macOS), PE (Windows)
const ELF_MACHINES = { 0x3e: "x64", 0xb7: "arm64" };
const MACHO_CPUS = { 0x01000007: "x64", 0x0100000c: "arm64" };
const PE_MACHINES = { 0x8664: "x64", 0xaa64: "arm64", 0x14c: "ia32" };
function binaryTarget(file) {
  const header = Buffer.alloc(4096);
  const fd = fs.openSync(file, "r");
  const length = fs.readSync(fd, header, 0, header.length, 0);
  fs.closeSync(fd);
  if (length < 64) return undefined;

  if (header.readUInt32BE(0) === 0x7f454c46) {
    const machine =
      header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
    return {
      os: "linux",
      archs: [ELF_MACHINES[machine] ?? `0x${machine.toString(16)}`],
    };
  }
  if (header.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = header.readUInt32LE(4);
    return {
      os: "darwin",
      archs: [MACHO_CPUS[cpu] ?? `0x${cpu.toString(16)}`],
    };
  }
  if (header.readUInt32BE(0) === 0xcafebabe) {
    // A universal binary: one slice per architecture
    const archs = [];
    for (let i = 0; i < header.readUInt32BE(4); i++) {
      const cpu = header.readUInt32BE(8 + i * 20);
      archs.push(MACHO_CPUS[cpu] ?? `0x${cpu.toString(16)}`);
    }
    return { os: "darwin", archs };
  }
  if (header.toString("latin1", 0, 2) === "MZ") {
    const peOffset = header.readUInt32LE(0x3c);
    if (
      peOffset + 6 > length ||
      header.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0"
    ) {
      return undefined;
    }
    const machine = header.readUInt16LE(peOffset + 4);
    return {
      os: "win32",
      archs: [PE_MACHINES[machine] ?? `0x${machine.toString(16)}`],
    };
  }
  return undefined;
}

// Every native module in the release and its Node.js, checked against the target
function checkNativeBinaries() {
  const binaries = [path.join(outDir, "bin", path.basename(nodeBinary))];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.name.endsWith(".node")) binaries.push(entryPath);
    }
  };
  walk(outDir);

  const wrong = binaries.flatMap((file) => {
    const built = binaryTarget(file);
    const ok = built?.os === targetOs && built.archs.includes(targetArch);
    return ok
      ? []
      : [
          `${path.relative(outDir, file)}: ${built ? `${built.os}-${built.archs.join("+")}` : "not a native binary"}`,
        ];
  });
  if (wrong.length > 0) {
    fail(
      `The ${target} release has binaries for another platform:\n  ${wrong.join("\n  ")}`,
    );
  }
  return binaries.length;
}

const pjson = readJson(path.join(serverDir, "package.json"));
const roots = pjson.oclif.dependenciesToPackage;
const packages = collectPackages(roots);

console.log(`Assembling the ${target} server release in ${outDir}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "bin"), { recursive: true });

// bin/: oclif's entry point, Node.js (with its license) and our launcher
const launcher = isWindows ? "httptoolkit-server.cmd" : "httptoolkit-server";
fs.copyFileSync(
  path.join(serverDir, "bin", "run"),
  path.join(outDir, "bin", "run"),
);
if (isWindows) {
  fs.copyFileSync(
    path.join(serverDir, "bin", "run.cmd"),
    path.join(outDir, "bin", "run.cmd"),
  );
}
fs.copyFileSync(
  nodeBinary,
  path.join(outDir, "bin", path.basename(nodeBinary)),
);
fs.copyFileSync(
  path.join(nodeDir, "LICENSE"),
  path.join(outDir, "bin", "node-LICENSE"),
);
fs.writeFileSync(
  path.join(outDir, "bin", launcher),
  isWindows ? WINDOWS_LAUNCHER : UNIX_LAUNCHER,
);
for (const bin of ["run", path.basename(nodeBinary), launcher])
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

// NSS tools for Firefox's certificate database: only the target OS's, with their license
fs.mkdirSync(path.join(outDir, "nss"));
copy(path.join(serverDir, "nss", targetOs), path.join(outDir, "nss", targetOs));
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
  copy(dir, path.join(outDir, path.relative(stagingDir, dir)), (src) => {
    const inner = relativeParts(dir, src);
    return (
      inner.includes("node_modules") ||
      // Build-time links to python left by node-gyp (upstream's setup-server.ts drops them too)
      inner.includes("node_gyp_bins") ||
      skipNativeFiles(dir, inner)
    );
  });
}

// package.json lists only the shipped dependencies, at their installed versions
const releaseJson = { ...pjson };
releaseJson.dependencies = {};
for (const name of roots) {
  releaseJson.dependencies[name] = packages.get(
    resolvePackage(name, stagingDir),
  ).version;
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

const binaryCount = checkNativeBinaries();
console.log(
  `Copied ${packages.size} packages into node_modules. All ${binaryCount} native binaries are for ${target}.`,
);
