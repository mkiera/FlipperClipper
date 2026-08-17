// Turns the project version into the four plain numbers a Windows version resource needs.
// The setup exe needs one: an executable with no company, product or version reads as
// suspicious to antivirus heuristics. Both callers that compile the installer ask this
// script, so no second parser can disagree about what "0.2.0-beta" means.
//
// Usage: node scripts/vernum.mjs [--raw]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

// A leading "v" is tolerated, so a caller holding a git tag gets the same answer. Anything
// unparseable falls back to Inno Setup's own default rather than failing a release.
function numericVersion(version) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!match) return '0.0.0.0';
  return [match[1], match[2] || '0', match[3] || '0', '0'].join('.');
}

const version = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version.trim();
process.stdout.write(process.argv.includes('--raw') ? version : numericVersion(version));
