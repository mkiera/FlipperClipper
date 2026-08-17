/**
 * Stamp a build with the commit and CI run that produced it.
 *
 * package.json says the same version for every build off a branch, so it
 * cannot answer "which build of 0.2.0 is this?" -- and that question comes up
 * the moment two people are running test artifacts from different commits. The
 * About tooltip answers it from this file instead of guessing from a version
 * string.
 *
 * Written into src/generated/ so Vite bundles it as a normal JSON import. That
 * directory is generated, never committed, and .gitignore says so; this script
 * therefore has to create it, because a fresh clone will not have one.
 *
 * Every field is optional and degrades to null. A build that cannot say which
 * commit it came from is a slightly worse About tooltip; a build that fails
 * because git was not on PATH is a broken release, and the tooltip is not worth
 * that trade.
 *
 * Usage: node scripts/build_info.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src', 'generated');
const outPath = join(outDir, 'build-info.json');

/** A git field, or null when this is not a checkout with git available. */
function git(...args) {
  try {
    const value = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * The checked-out branch, or null when this build did not come from one.
 *
 * "git rev-parse --abbrev-ref HEAD" answers the literal string "HEAD" on a
 * detached checkout, which is not a branch name and reads as one once it has
 * been stamped into a field called "branch".
 */
function localBranch() {
  const name = git('rev-parse', '--abbrev-ref', 'HEAD');
  return name === 'HEAD' ? null : name;
}

// GITHUB_HEAD_REF is set only for pull requests, where GITHUB_REF_NAME would be
// the synthetic "123/merge" ref rather than the branch anyone would recognise.
//
// GITHUB_REF_NAME is not always a branch: build-release.yml triggers on tags
// only, and there it holds the tag, so an unguarded read stamps
// "branch": "v0.2.0" onto every release -- a field that repeats the version and
// answers nothing. GITHUB_REF_TYPE is what distinguishes the two.
const branch = process.env.GITHUB_HEAD_REF
  || (process.env.GITHUB_REF_TYPE === 'branch' ? process.env.GITHUB_REF_NAME : null)
  || localBranch();

const runId = process.env.GITHUB_RUN_ID;

const info = {
  sha: process.env.GITHUB_SHA || git('rev-parse', 'HEAD'),
  branch: branch || null,
  // Only CI runs have one. A local build leaves it null, which is correct: it
  // was never uploaded as an artifact, so there is no run to link back to.
  runId: runId && /^\d+$/.test(runId) ? Number(runId) : null,
  builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
console.log(`${outPath}:`, info);
