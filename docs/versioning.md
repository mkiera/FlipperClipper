# Versioning

Use this convention for releases after `v1.1.3`. Keep existing tags, release
assets, and release notes unchanged, including `v0.1.0-beta` through
`v0.1.16-beta`. The updater continues to accept those versions.

| Build | Tag | Application version |
| --- | --- | --- |
| Stable | `v1.1.4` | `1.1.4` |
| Beta | `v1.1.4-beta.1` | `1.1.4-beta.1` |
| Branch build two commits after `v1.1.3` | none | `1.1.4-alpha.2` |

`package.json` holds the local core with three numeric parts. Release builds override
Tauri's version from the tag without editing package files. The installer
uses the same semantic version and derives its Windows resource version as
`major.minor.patch.0`. The Cargo crate version is independent of the application
version read by Tauri and the updater.

## Prepare a release

1. Integrate changes into `beta`. Merge work with multiple commits using
   `git merge --no-ff`. Add user-visible changes to `CHANGELOG.md` under
   `## Unreleased`.
2. Choose a patch for compatible fixes, a minor for compatible functionality,
   or a major for incompatible public changes. Keep that core throughout its
   beta series. Update `package.json` and its lockfile together when the core changes.
3. Move the changes into `## 1.1.4-beta.1 - YYYY-MM-DD`, using the actual
   version and date. Leave an empty Unreleased section. Stable notes collect
   the results of the beta series under a separate stable heading.
4. Run `npm ci`, `npm test`, `npm run build`, and
   `cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=1`.
5. On an explicit release request, create a lightweight beta tag at the prepared
   `beta` head. For stable, merge `beta` into `main` with `--no-ff` and tag that
   merge. Push the branch and tag atomically. Verify the workflow and its
   `FlipperClipper-Setup.exe` asset.

Keep tagged changelog sections frozen. Historical releases retain their existing
GitHub notes and do not need backfilled sections. New releases require one exact,
nonempty changelog section. Tags accept only stable or numbered beta forms.
CI checks that beta tags match the remote `beta` head and stable tags match
the remote `main` merge from `beta`. Do not merge `main` back into `beta`.

## Branch builds

Every pushed branch runs `.github/workflows/build-test.yml`. A newer push
cancels an older run on the same branch. Successful installers use the existing
`FlipperClipper-Setup` artifact name and expire after 30 days.

`scripts/versioning.mjs` calculates alpha versions from full Git history.
It uses commit distance from the nearest version tag and accounts for stable
tags on `main` that are outside `beta` ancestry. A build exactly on a tag
keeps that tag's version. A repository without version tags uses the workflow
run number. Alpha builds have no release tag and are installed manually.

Keep the installer AppId, application data paths, executable name, release
asset name, and workflow filename intact so installed versions retain their
update and downgrade paths.
