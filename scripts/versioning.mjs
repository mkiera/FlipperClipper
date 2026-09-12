import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const number = '(0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const pattern = new RegExp(`^v?${number}\\.${number}\\.${number}(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);

export function parseVersion(value) {
  const match = pattern.exec(value);
  if (!match || match[0] !== value) throw new Error(`Invalid semantic version: ${value}`);
  return { core: match.slice(1, 4).join('.'), pre: match[4] ?? '', version: value.replace(/^v/, '') };
}

export function compareCore(left, right) {
  const a = parseVersion(left).core.split('.').map(BigInt);
  const b = parseVersion(right).core.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function releaseVersion(tag) {
  const parsed = parseVersion(tag);
  if (!/^v\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/.test(tag)) {
    throw new Error('New release tags must use vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-beta.N (N starts at 1).');
  }
  return parsed;
}

function nextPatch(core) {
  const parts = core.split('.');
  parts[2] = String(BigInt(parts[2]) + 1n);
  return parts.join('.');
}

export function alphaVersion({ aimedCore, nearestTag, distance, latestStable, runNumber }) {
  const aimed = parseVersion(aimedCore).core;
  if (!nearestTag) {
    if (!/^[1-9]\d*$/.test(String(runNumber))) throw new Error('A positive workflow run number is required.');
    return `${aimed}-alpha.${runNumber}`;
  }
  if (!Number.isSafeInteger(distance) || distance < 0) throw new Error('Invalid commit distance.');
  const nearest = parseVersion(nearestTag);
  if (distance === 0) return nearest.version;
  if (compareCore(aimed, nearest.core) > 0) return `${aimed}-alpha.${distance}`;
  if (nearest.pre && latestStable && compareCore(latestStable, nearest.core) >= 0) {
    const floor = nextPatch(parseVersion(latestStable).core);
    return `${compareCore(aimed, floor) > 0 ? aimed : floor}-alpha.${distance}`;
  }
  if (nearest.pre) return `${nearest.core}-${nearest.pre}.alpha.${distance}`;
  return `${nextPatch(nearest.core)}-alpha.${distance}`;
}

export function releaseNotes(changelog, version) {
  parseVersion(version);
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const headings = lines.map((line, index) => ({ line, index })).filter(({ line }) => {
    const match = /^## (\S+)(?: - \d{4}-\d{2}-\d{2})?\s*$/.exec(line);
    return match?.[1] === version;
  });
  if (headings.length !== 1) throw new Error(`Expected one changelog section for ${version}.`);
  const start = headings[0].index + 1;
  let end = lines.findIndex((line, index) => index >= start && /^## /.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(start, end).join('\n').trim();
  if (!body || !body.replace(/<!--[\s\S]*?-->/g, '').trim()) throw new Error(`Empty changelog section for ${version}.`);
  return body;
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function validatePlacement(root, tag) {
  const parsed = releaseVersion(tag);
  const commit = git(root, 'rev-parse', `${tag}^{commit}`);
  const branch = parsed.pre ? 'beta' : 'main';
  if (commit !== git(root, 'rev-parse', `refs/remotes/origin/${branch}`)) {
    throw new Error(`${tag} must point to the current ${branch} head.`);
  }
  if (!parsed.pre) {
    const parents = git(root, 'show', '-s', '--format=%P', commit).split(' ');
    if (parents.length !== 2 || parents[1] !== git(root, 'rev-parse', 'refs/remotes/origin/beta')) {
      throw new Error('A stable release must be a two-parent merge from beta into main.');
    }
  }
}

export function versionFromGit(root, runNumber) {
  const aimedCore = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (git(root, 'rev-parse', '--is-shallow-repository') === 'true') throw new Error('Alpha versioning requires full Git history.');
  const tags = git(root, 'tag', '--list', 'v[0-9]*').split('\n').filter(Boolean);
  const stable = tags.filter(tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)).sort(compareCore);
  let described;
  try {
    described = git(root, 'describe', '--tags', '--long', '--match', 'v[0-9]*');
  } catch (error) {
    if (!String(error.stderr).includes('No names found') && !String(error.stderr).includes('No tags can describe')) throw error;
  }
  const match = described?.match(/^(v.+)-(\d+)-g[0-9a-f]+$/);
  if (described && !match) throw new Error(`Invalid git describe result: ${described}`);
  return alphaVersion({ aimedCore, nearestTag: match?.[1], distance: Number(match?.[2]), latestStable: stable.at(-1), runNumber });
}

function prepare(root, mode, tag) {
  let version;
  let notes;
  if (mode === 'release') {
    const parsed = releaseVersion(tag);
    validatePlacement(root, tag);
    version = parsed.version;
    notes = releaseNotes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  } else if (mode === 'alpha') {
    version = versionFromGit(root, process.env.GITHUB_RUN_NUMBER);
  } else {
    throw new Error('Usage: node scripts/versioning.mjs alpha | release <tag>');
  }
  const output = join(root, 'src', 'generated');
  mkdirSync(output, { recursive: true });
  const config = join(output, 'tauri-version.json');
  writeFileSync(config, `${JSON.stringify({ version })}\n`);
  if (notes) {
    writeFileSync(join(output, 'release-notes.md'), `${notes}\n\n<!-- app-notes-end -->\n\n### Installation\n\nRun FlipperClipper-Setup.exe to install or update. Your install location and shortcut choice are preserved.\n\nFlipperClipper uses FFmpeg for exports and offers to install it when missing.\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `VERSION=${version}\nRELEASE_NAME=v${version}\nIS_PRERELEASE=${Boolean(parseVersion(version).pre)}\n`);
  }
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `FC_BUILD_VERSION=${version}\nFC_BUILD_CONFIG=${config}\n`);
  }
  console.log(version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare(join(dirname(fileURLToPath(import.meta.url)), '..'), process.argv[2], process.argv[3]);
}
