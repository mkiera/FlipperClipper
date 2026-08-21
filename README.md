# FlipperClipper 🦭

*Flip it, clip it, ship it.* FinFetcher's sibling: a small Windows video editor
for the edit you make right before you send someone a clip. Open a video, trim
it, crop it, speed it up or slow it down, reverse it, tweak the volume — then
export it as a video, a GIF, or just the audio. That is the whole app.

There are no project files, no timeline of multiple clips, and nothing to save.
Open, edit, export, done.

Built with [Tauri 2](https://tauri.app) — a Rust shell around a WebView2 UI, so
the download is small and it starts instantly. Preview playback is the browser's
own hardware-accelerated decoder, so scrubbing, trimming and speed changes never
re-encode anything; FFmpeg reads the file when you open it, paints the filmstrip
under the timeline, and does the export.

## Install

Download `FlipperClipper-Setup.exe` from
[Releases](https://github.com/mkiera/FlipperClipper/releases) and run it. It
installs for you alone into `%LOCALAPPDATA%\Programs\FlipperClipper` and never
asks for admin rights.

### Updates

The app checks for new releases on launch and can update itself in place. The
check talks to GitHub's public API anonymously — it carries no token and no
account. That has one consequence worth knowing while this repository is
private: an anonymous request to a private repository gets a 404, so installed
copies cannot see releases until the repository is public. The moment it is, the
same builds start updating themselves with no change on their end.

## The controls

- **Open** — the Open button, `Ctrl` + `O`, dropping a file onto the window, or
  the command line (`FlipperClipper.exe "C:\clips\holiday.mp4"`).
- **Trim** — drag the in/out handles on the timeline, or set them with `I` and
  `O` at the playhead.
- **Timeline zoom** — scroll the mouse wheel over the timeline, or use the
  zoom in / zoom out / fit buttons beside it.
- **Speed** — the slider covers 0.25×–8× with notches at the useful stops; type
  into the number box for anything from 0.05× to 20×.
- **Reverse** — plays and exports the clip backwards. Audio reverses with it.
- **Volume** — 0–200%. A boost above 100% is applied in the export; the preview
  player cannot play louder than full volume, so you hear the boost in the
  exported file.
- **Crop, mute** — as ever: `C` to enter crop mode, `M` to mute.
- **Format** — a dropdown with `mp4`, `mkv`, `mov`, `webm` and `gif`, plus an
  audio-only toggle that swaps the list for `mp3`, `m4a`, `wav`, `flac`, `ogg`
  and `opus` and exports just the sound.
- **Quality** — high / balanced / small, or **fit**, which takes a target size
  in MB (typed, not picked from a preset) and aims the export at it. Fit cannot
  work for GIF or for the uncompressed and lossless audio formats (`wav`,
  `flac`), and the app refuses those combinations rather than guessing.

## FFmpeg

FlipperClipper needs [FFmpeg](https://ffmpeg.org) on your PATH: `ffprobe` reads
a video's details the moment you open one, and `ffmpeg` does the export. It is
not bundled — an FFmpeg build dwarfs the app, and paying for it in every
download would be paying for something many people already have. A system
install also stays up to date on its own.

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
| `R` | Reverse |
| `C` | Crop mode — press again to apply the crop |
| `Enter` | Apply the crop, in crop mode |
| `Ctrl` + `O` | Open a video |
| `Ctrl` + `E` | Export |
| `Esc` | Leave crop mode, close the export options, or dismiss a message |

The mouse wheel zooms the timeline under the pointer; the zoom buttons next to
it do the same in steps, and the fit button brings the whole clip back into
view.

A running export is stopped with the Cancel button next to the progress bar, not
with `Esc`.

## Building locally

Needs Node 20+, a stable Rust toolchain (`stable-msvc`), and the Visual Studio
C++ build tools.

```
npm install
npm run tauri dev     # run it
```

To produce a real installer, double-click **`build exe.bat`**. It builds the
release exe, finds Inno Setup, and leaves `FlipperClipper-Setup.exe` in your
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
the installer, and publishes a GitHub Release with `FlipperClipper-Setup.exe`
attached. A tag containing a hyphen — `v0.2.0-beta` — is published as a
pre-release, and only pre-release builds are offered pre-release updates.

Pushing to a `feature/**` or `bugfix/**` branch runs
`.github/workflows/build-test.yml`, which produces the same installer as a
30-day workflow artifact without publishing anything.

## Licence

GNU General Public License v3.0 or later. See [LICENSE](LICENSE).

FlipperClipper runs FFmpeg as a separate program and does not bundle it, so
FFmpeg's own licence stays on its own side of that line. Bundling an FFmpeg
binary into the installer would change that: the common full builds are GPL
themselves, and shipping one alongside would put its terms on the whole
distribution.
