#!/usr/bin/env node
/**
 * Writes electron/build-info.json, bundled into the desktop app by
 * electron-builder (`files: ["**\/*"]` under directories.app = electron).
 *
 * The packaged app's "Custom build" card (electron/self-update.mjs) reads it to
 * learn which clone it was built from and at which commit. The file is
 * generated and git-ignored; run as part of `npm run build:desktop`.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** The release this build sits on; null in a clone without tags. */
function upstreamTag() {
  try {
    return (
      git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*") || null
    );
  } catch {
    return null;
  }
}

const info = {
  repoPath: repoRoot,
  commitSha: git("rev-parse", "HEAD"),
  branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  upstreamTag: upstreamTag(),
  buildTime: new Date().toISOString(),
};

const out = join(repoRoot, "electron", "build-info.json");
writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
console.log(
  `[build-info] ${info.branch} @ ${info.commitSha.slice(0, 10)} -> ${out}`,
);
