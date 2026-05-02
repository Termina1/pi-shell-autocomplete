#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((arg) => !arg.startsWith("-"));
const versionArg = positional[0];

function pkg() {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
}

function format(command, commandArgs) {
  return [command, ...commandArgs].join(" ");
}

function run(command, commandArgs, options = {}) {
  const label = format(command, commandArgs);
  if (dryRun && options.mutates) {
    console.log(`[dry-run] skip: ${label}`);
    return { stdout: "", stderr: "", status: 0 };
  }

  console.log(`$ ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${label}`);
  }

  return result;
}

function capture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });

  if (options.allowFailure) return result;
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${format(command, commandArgs)}\n${result.stderr}`);
  }
  return result;
}

function ensureCleanGit() {
  const status = capture("git", ["status", "--porcelain"]).stdout.trim();
  if (!status) return;

  if (dryRun) {
    console.warn("[dry-run] working tree is not clean; real release would stop here:\n" + status);
    return;
  }

  throw new Error(
    "Working tree is not clean. Commit or stash changes before releasing.\n\n" + status,
  );
}

function ensureTagDoesNotExist(tag) {
  const local = capture("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { allowFailure: true });
  if (local.status === 0) throw new Error(`Local git tag already exists: ${tag}`);

  const remote = capture("git", ["ls-remote", "--tags", "origin", tag], { allowFailure: true });
  if (remote.status === 0 && remote.stdout.trim()) {
    throw new Error(`Remote git tag already exists on origin: ${tag}`);
  }
}

function computeTargetVersion(currentVersion, requested) {
  if (!requested) return currentVersion;
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return requested;

  const [, majorRaw, minorRaw, patchRaw] = match;
  let major = Number(majorRaw);
  let minor = Number(minorRaw);
  let patch = Number(patchRaw);

  if (requested === "patch") patch += 1;
  else if (requested === "minor") {
    minor += 1;
    patch = 0;
  } else if (requested === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(requested)) return requested;
  else return requested;

  return `${major}.${minor}.${patch}`;
}

function ensureNpmVersionIsFree(name, version) {
  const result = capture("npm", ["view", `${name}@${version}`, "version"], { allowFailure: true });
  if (result.status === 0) {
    throw new Error(`npm package version already exists: ${name}@${version}`);
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (!/E404|404 Not Found|No match found/i.test(output)) {
    throw new Error(`Could not confirm npm version availability for ${name}@${version}:\n${output}`);
  }
}

const initialPkg = pkg();
if (!initialPkg.name || !initialPkg.version) {
  throw new Error("package.json must contain name and version before releasing.");
}

const targetVersion = computeTargetVersion(initialPkg.version, versionArg);
const tag = `v${targetVersion}`;

console.log(`Release target: ${initialPkg.name}@${targetVersion} (${tag})${dryRun ? " [dry-run]" : ""}`);

run("git", ["--version"]);
run("npm", ["--version"]);
run("gh", ["--version"]);
ensureCleanGit();
ensureTagDoesNotExist(tag);
ensureNpmVersionIsFree(initialPkg.name, targetVersion);
run("gh", ["auth", "status"]);
run("npm", ["whoami"]);

run("npm", ["run", "test:unit"]);
run("npm", ["pack", "--dry-run"]);

if (versionArg) {
  run("npm", ["version", versionArg, "-m", "chore(release): v%s"], { mutates: true });
} else {
  run("git", ["tag", "-a", tag, "-m", tag], { mutates: true });
}

run("git", ["push", "origin", "HEAD", "--follow-tags"], { mutates: true });
run("gh", ["release", "create", tag, "--verify-tag", "--generate-notes"], { mutates: true });
run("npm", ["publish", "--access", "public"], { mutates: true });

console.log(`Released ${initialPkg.name}@${targetVersion}`);
