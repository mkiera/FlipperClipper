# QuickClip

A small Windows video editor for the edit you make right before you send someone
a clip. Open a video, trim it, optionally crop the frame, change the speed or
mute it, export an MP4. That is the whole app.

There are no project files, no timeline of multiple clips, and nothing to save.
Open, edit, export, done.

Built with [Tauri 2](https://tauri.app) — a Rust shell around a WebView2 UI, so
the download is small and it starts instantly. Preview playback is the browser's
own hardware-accelerated decoder, so scrubbing, trimming and speed changes never
re-encode anything; FFmpeg reads the file when you open it, paints the filmstrip
under the timeline, and does the export.

## Install

Download `QuickClip-Setup.exe` from
[Releases](https://github.com/mkiera/QuickClip/releases) and run it. It installs
for you alone into `%LOCALAPPDATA%\Programs\QuickClip` and never asks for admin
rights. The app checks for new releases on launch and can update itself in
place.

## FFmpeg

QuickClip needs [FFmpeg](https://ffmpeg.org) on your PATH: `ffprobe` reads a
video's details the moment you open one, and `ffmpeg` does the export. It is not
bundled — an FFmpeg build dwarfs the app, and paying for it in every download
would be paying for something many people already have. A system install also
stays up to date on its own.

If it is missing, the app shows a banner with a one-click install button that
runs:

```
winget install -e --id Gyan.FFmpeg
```

You can also install it yourself, any way you like, as long as `ffmpeg` and
`ffprobe` end up on PATH.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Step one frame |
| `Shift` + `←` / `→` | Jump one second |
| `I` / `O` | Set the in / out point at the playhead |
| `Home` / `End` | Jump to the in / out point |
| `M` | Mute (when the clip has audio) |
| `C` | Crop mode — press again to apply the crop |
| `Enter` | Apply the crop, in crop mode |
| `Ctrl` + `O` | Open a video |
| `Ctrl` + `E` | Export |
| `Esc` | Leave crop mode, close the export options, or dismiss a message |

A running export is stopped with the Cancel button next to the progress bar, not
with `Esc`.

You can also drop a video onto the window, or open one from the command line
(`QuickClip.exe "C:\clips\holiday.mp4"`).

## Building locally

Needs Node 20+, a stable Rust toolchain (`stable-msvc`), and the Visual Studio
C++ build tools.

```
npm install
npm run tauri dev     # run it
```

To produce a real installer, double-click **`build exe.bat`**. It builds the
release exe, finds Inno Setup, and leaves `QuickClip-Setup.exe` in your
Downloads folder. If Inno Setup is missing it tells you how to install it
(`winget install -e --id JRSoftware.InnoSetup`) and points you at the app exe,
which is built and runnable either way.

## Releases

`package.json`'s `version` field is the single source of truth — `tauri.conf.json`
reads it, `scripts/vernum.mjs` derives the four-number Windows form from it, and
the installer is handed both.

A release is cut by pushing a tag:

```
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/build-release.yml` then writes the tag's version into
`package.json` (the tag is the authority for what a build *is*), builds, packages
the installer, and publishes a GitHub Release with `QuickClip-Setup.exe`
attached. A tag containing a hyphen — `v0.2.0-beta` — is published as a
pre-release, and only pre-release builds are offered pre-release updates.

Pushing to a `feature/**` or `bugfix/**` branch runs
`.github/workflows/build-test.yml`, which produces the same installer as a
30-day workflow artifact without publishing anything.

## Licence

MIT. See [LICENSE](LICENSE).
