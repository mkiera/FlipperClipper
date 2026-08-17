// Stamps the commit and CI run that produced this build into src/generated/, where Vite
// bundles it as a normal JSON import. That directory is generated and never committed, so
// this script creates it. Every field degrades to null rather than failing a release.
//
// Usage: node scripts/build_info.mjs
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

// rev-parse --abbrev-ref answers the literal string "HEAD" on a detached checkout, which is
// not a branch name and reads as one once stamped into a field called "branch".
function localBranch() {
  const name = git('rev-parse', '--abbrev-ref', 'HEAD');
  return name === 'HEAD' ? null : name;
}

// GITHUB_HEAD_REF is set only for pull requests, where GITHUB_REF_NAME would be the synthetic
// "123/merge" ref. GITHUB_REF_NAME is not always a branch either: build-release.yml triggers
// on tags, so an unguarded read stamps "branch": "v0.2.0" onto every release.
const branch = process.env.GITHUB_HEAD_REF
  || (process.env.GITHUB_REF_TYPE === 'branch' ? process.env.GITHUB_REF_NAME : null)
  || localBranch();

const runId = process.env.GITHUB_RUN_ID;

const info = {
  sha: process.env.GITHUB_SHA || git('rev-parse', 'HEAD'),
  branch: branch || null,
  // Only CI runs have one. A local build was never uploaded as an artifact, so null is correct.
  runId: runId && /^\d+$/.test(runId) ? Number(runId) : null,
  builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
console.log(`${outPath}:`, info);
