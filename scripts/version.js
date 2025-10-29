#!/usr/bin/env node

/**
 * Automated version bumping and tagging utility.
 *
 * - Bumps the package.json version (defaults to patch).
 * - Commits staged changes together with the updated package.json.
 * - Creates an annotated git tag following the main@<version> convention.
 *
 * Usage:
 *   node scripts/version.js [--bump patch|minor|major] [--commit-message "<msg>"] [--tag-prefix main@] [--force-tag]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);

function parseArgs(list) {
  const options = {
    bump: "patch",
    commitMessage: undefined,
    tagPrefix: "main@",
    forceTag: false,
  };

  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    switch (arg) {
      case "--bump":
        options.bump = list[++i] ?? "";
        break;
      case "--commit-message":
        options.commitMessage = list[++i] ?? "";
        break;
      case "--tag-prefix":
        options.tagPrefix = list[++i] ?? "main@";
        break;
      case "--force-tag":
        options.forceTag = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function runCommand(command, params, options = {}) {
  const result = spawnSync(command, params, {
    stdio: ["inherit", "inherit", "inherit"],
    ...options,
  });

  if (result.status !== 0) {
    const cmd = [command, ...params].join(" ");
    throw new Error(`Command failed: ${cmd}`);
  }

  return result;
}

function runCapture(command, params) {
  const result = spawnSync(command, params, { encoding: "utf8" });
  if (result.status !== 0) {
    const cmd = [command, ...params].join(" ");
    throw new Error(`Command failed: ${cmd}`);
  }
  return result.stdout.trim();
}

function ensureInsideRepo() {
  runCommand("git", ["rev-parse", "--is-inside-work-tree"]);
}

function ensureStagedChanges() {
  const staged = runCapture("git", ["diff", "--cached", "--name-only"]);
  if (!staged) {
    throw new Error("No staged changes detected. Stage files before running the version script.");
  }
}

function bumpVersion(current, bumpType) {
  const parts = current.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid semantic version: ${current}`);
  }

  const [major, minor, patch] = parts;

  switch (bumpType) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unsupported bump type: ${bumpType}`);
  }
}

function stageVersionFile() {
  runCommand("git", ["add", "package.json"]);
}

function createCommit(message) {
  if (!message) {
    return;
  }
  runCommand("git", ["commit", "-m", message]);
}

function createTag(tagName, forceTag) {
  const tagArgs = forceTag ? ["-fa", tagName] : ["-a", tagName];
  runCommand("git", ["tag", ...tagArgs, `-m`, `Release ${tagName}`]);
}

function main() {
  const options = parseArgs(args);

  ensureInsideRepo();

  const pkgRaw = readFileSync("package.json", "utf8");
  const pkg = JSON.parse(pkgRaw);

  const newVersion = bumpVersion(pkg.version, options.bump);
  pkg.version = newVersion;

  writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

  stageVersionFile();

  ensureStagedChanges();

  const commitMessage =
    options.commitMessage ?? `chore: release ${options.tagPrefix}${newVersion}`;

  createCommit(commitMessage);

  const tagName = `${options.tagPrefix}${newVersion}`;
  createTag(tagName, options.forceTag);

  process.stdout.write(`${newVersion}\n`);
}

try {
  main();
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
}

