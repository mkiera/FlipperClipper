import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { alphaVersion, parseVersion, releaseNotes, releaseVersion, validatePlacement, versionFromGit } from '../scripts/versioning.mjs';

test('historical versions remain parseable while new tags require numbered betas', () => {
  for (let patch = 0; patch <= 16; patch++) {
    const version = `0.1.${patch}-beta`;
    assert.equal(parseVersion(`v${version}`).version, version);
    assert.throws(() => releaseVersion(`v${version}`));
  }
  for (const tag of ['v1.0.0', 'v1.1.0', 'v1.1.1', 'v1.1.2', 'v1.1.3', 'v1.1.4-beta.1', 'v1.1.4-beta.11']) {
    assert.equal(releaseVersion(tag).version, tag.slice(1));
  }
});

test('invalid SemVer and unsupported new release forms are rejected', () => {
  for (const version of ['1.2', '1.2.3.4', '01.2.3', '1.2.3-beta.01', '1.2.3-', '1.2.3+','1.2.3-a..b', 'vv1.2.3', '1.2.3 beta', '1.2.3\n']) {
    assert.throws(() => parseVersion(version), version);
  }
  for (const tag of ['1.2.3', 'v1.2.3-alpha.1', 'v1.2.3-rc.1', 'v1.2.3-beta.0', 'v1.2.3+build.1']) {
    assert.throws(() => releaseVersion(tag), tag);
  }
  assert.equal(parseVersion('1.2.3-beta.1+build.05').pre, 'beta.1');
});

test('alpha versions follow the Companion examples and historical beta tags', () => {
  const cases = [
    [{ aimedCore: '0.1.0', runNumber: 17 }, '0.1.0-alpha.17'],
    [{ nearestTag: 'v1.4.0-beta.1', distance: 0 }, '1.4.0-beta.1'],
    [{ nearestTag: 'v1.4.0-beta.1', distance: 3, latestStable: 'v1.3.2' }, '1.4.0-beta.1.alpha.3'],
    [{ nearestTag: 'v1.4.0', distance: 2 }, '1.4.1-alpha.2'],
    [{ aimedCore: '1.5.0', nearestTag: 'v1.4.0', distance: 2 }, '1.5.0-alpha.2'],
    [{ nearestTag: 'v1.4.0-beta.1', distance: 2, latestStable: 'v1.4.0' }, '1.4.1-alpha.2'],
    [{ aimedCore: '0.1.16', nearestTag: 'v0.1.16-beta', distance: 0 }, '0.1.16-beta'],
    [{ aimedCore: '0.1.16', nearestTag: 'v0.1.16-beta', distance: 3 }, '0.1.16-beta.alpha.3'],
    [{ nearestTag: 'v1.4.0-beta.2', distance: 4, latestStable: 'v1.10.0' }, '1.10.1-alpha.4'],
    [{ aimedCore: '2.0.0', nearestTag: 'v1.4.0-beta.2', distance: 4 }, '2.0.0-alpha.4'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(alphaVersion({ aimedCore: '1.4.0', ...input }), expected);
  }
  assert.throws(() => alphaVersion({ aimedCore: '1.0.0' }));
  assert.throws(() => alphaVersion({ aimedCore: '1.0.0', nearestTag: 'v1.0.0', distance: -1 }));
});

test('release notes require one exact nonempty section', () => {
  const notes = '# Changelog\r\n\r\n## Unreleased\r\n\r\n## 1.2.0-beta.11 - 2026-09-12\r\n\r\n- Eleven.\r\n\r\n## 1.2.0-beta.1 - 2026-09-11\r\n\r\n- One.\r\n';
  assert.equal(releaseNotes(notes, '1.2.0-beta.1'), '- One.');
  assert.equal(releaseNotes(notes, '1.2.0-beta.11'), '- Eleven.');
  assert.throws(() => releaseNotes(notes, '1.2.0'));
  assert.throws(() => releaseNotes('## 1.2.0\n\n## 1.1.0\n- Old.', '1.2.0'));
  assert.throws(() => releaseNotes('## 1.2.0\n<!-- pending -->', '1.2.0'));
  assert.throws(() => releaseNotes('## 1.2.0\n- One.\n## 1.2.0\n- Two.', '1.2.0'));
});

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'flipperclipper-versions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Version tests');
  git('config', 'user.email', 'versions@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  writeFileSync(join(root, 'package.json'), '{"version":"1.4.0"}\n');
  git('add', 'package.json');
  git('commit', '-m', 'Initial version');
  return { root, git };
}

test('Git alpha calculation sees a stable merge outside beta ancestry', t => {
  const { root, git } = repository(t);
  assert.equal(versionFromGit(root, 17), '1.4.0-alpha.17');
  git('switch', '-c', 'beta');
  git('commit', '--allow-empty', '-m', 'Prepare beta');
  git('tag', '-a', 'v1.4.0-beta.1', '-m', 'Beta');
  const oldTag = git('rev-parse', 'v1.4.0-beta.1');
  assert.equal(versionFromGit(root, 18), '1.4.0-beta.1');
  git('switch', 'main');
  git('merge', '--no-ff', 'beta', '-m', 'Release 1.4.0');
  git('tag', 'v1.4.0');
  git('switch', 'beta');
  git('commit', '--allow-empty', '-m', 'First change');
  git('commit', '--allow-empty', '-m', 'Second change');
  assert.equal(versionFromGit(root, 19), '1.4.1-alpha.2');
  assert.equal(git('rev-parse', 'v1.4.0-beta.1'), oldTag);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '1.4.0');
});

test('release placement requires beta head or a main release merge', t => {
  const { root, git } = repository(t);
  git('switch', '-c', 'beta');
  git('commit', '--allow-empty', '-m', 'Prepare beta');
  git('tag', 'v1.4.0-beta.1');
  git('update-ref', 'refs/remotes/origin/beta', 'HEAD');
  validatePlacement(root, 'v1.4.0-beta.1');
  git('tag', 'v1.4.0');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.throws(() => validatePlacement(root, 'v1.4.0'), /merge/);
  git('tag', '-d', 'v1.4.0');
  git('switch', 'main');
  git('merge', '--no-ff', 'beta', '-m', 'Release 1.4.0');
  git('tag', 'v1.4.0');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  validatePlacement(root, 'v1.4.0');
  git('switch', 'beta');
  git('commit', '--allow-empty', '-m', 'More work');
  git('update-ref', 'refs/remotes/origin/beta', 'HEAD');
  assert.throws(() => validatePlacement(root, 'v1.4.0-beta.1'), /head/);
});

test('installer version uses the build override without changing package.json', () => {
  const command = version => execFileSync(process.execPath, ['scripts/vernum.mjs'], { encoding: 'utf8', env: { ...process.env, FC_BUILD_VERSION: version } });
  assert.equal(command('1.4.0-beta.11'), '1.4.0.0');
  assert.equal(command('0.1.16-beta'), '0.1.16.0');
});

test('release preparation stamps Tauri and CI outputs without rewriting package versions', t => {
  const { root, git } = repository(t);
  git('switch', '-c', 'beta');
  git('tag', 'v1.4.0-beta.1');
  git('update-ref', 'refs/remotes/origin/beta', 'HEAD');
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../scripts/versioning.mjs', import.meta.url), join(root, 'scripts', 'versioning.mjs'));
  writeFileSync(join(root, 'CHANGELOG.md'), '## Unreleased\n\n## 1.4.0-beta.1 - 2026-09-12\n\n- Release changes.\n');
  const output = join(root, 'outputs');
  const env = join(root, 'environment');
  execFileSync(process.execPath, ['scripts/versioning.mjs', 'release', 'v1.4.0-beta.1'], {
    cwd: root, env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_ENV: env },
  });
  assert.equal(JSON.parse(readFileSync(join(root, 'src/generated/tauri-version.json'), 'utf8')).version, '1.4.0-beta.1');
  assert.match(readFileSync(output, 'utf8'), /VERSION=1\.4\.0-beta\.1\nRELEASE_NAME=v1\.4\.0-beta\.1\nIS_PRERELEASE=true/);
  assert.match(readFileSync(env, 'utf8'), /FC_BUILD_VERSION=1\.4\.0-beta\.1/);
  assert.match(readFileSync(join(root, 'src/generated/release-notes.md'), 'utf8'), /^- Release changes\.\n\n<!-- app-notes-end -->/);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '1.4.0');
});
