/**
 * Turn the project version into the four plain numbers Windows insists on.
 *
 * Tauri writes the app exe's own version resource straight out of
 * tauri.conf.json, so the half of FinFetcher's make_version_info.py that built
 * a VSVersionInfo block has no port here. The other half does: a Windows
 * version resource needs four integers, and a version like "0.2.0-beta" is not
 * that. The setup exe produced by installer.iss still needs one -- an
 * executable with no company, product or version reads as suspicious to
 * antivirus heuristics, and on FinFetcher adding that resource measurably
 * removed a detection on VirusTotal -- so the rule has to live somewhere.
 *
 * It lives here and only here. Both callers that compile the installer (the CI
 * workflows and "build exe.bat") ask this script rather than parsing the
 * version themselves, so there is no second parser that could quietly disagree
 * about what "0.2.0-beta" means.
 *
 * package.json's "version" is the single source of truth for the whole project:
 * tauri.conf.json points its own version field at that file, so the app, the
 * installer and the updater are all reporting one number.
 *
 * Usage:
 *   node scripts/vernum.mjs         ->  0.2.0.0
 *   node scripts/vernum.mjs --raw   ->  0.2.0-beta
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

/**
 * "major.minor.patch.0" from any version string.
 *
 * The trailing zero is a build field this project never uses; Windows wants
 * four numbers regardless. A leading "v" is tolerated so that a caller holding
 * a git tag rather than the package version gets the same answer. Anything
 * unparseable falls back to Inno Setup's own default for VersionInfoVersion
 * instead of failing a release over a cosmetic field.
 */
function numericVersion(version) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!match) return '0.0.0.0';
  return [match[1], match[2] || '0', match[3] || '0', '0'].join('.');
}

const version = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version.trim();
process.stdout.write(process.argv.includes('--raw') ? version : numericVersion(version));
