# Changelog

## Unreleased

- Join several videos into one. Add clips with the new button beside the timeline zoom, or drop several files at once, and they line up on one timeline in name order. Split the clip under the playhead with X or the scissors button. Drag a clip in the clip lane above the filmstrip to move it, and press its cross or Delete to remove it. Playback runs straight through the clips, and the export joins them into one file. Trim, speed, effects, crop and the audio tracks apply to the joined video. Clips of another size are fitted inside the first clip's frame with black bars.

## 1.3.0 - 2026-11-10

- Cancel now stops an export even when it is clicked in the first moments after Export, so the existing file is left alone.
- If a finished export cannot replace a locked or read-only file, it is kept beside it, and the message says where.
- Closing the window during an export no longer leaves a part-written file in the export folder.
- Export error messages keep FFmpeg's full explanation when the source has unusual text in its metadata.
- Update and FFmpeg downloads stop with an error and a Retry button when the connection stalls, instead of hanging.
- Checking for updates while one is downloading no longer interrupts the download, and the installer file can no longer be corrupted by two downloads at once.
- Automatic update checks run every hour as intended, not every two hours.
- The default output size setting is kept after a restart.
- Settings are saved safely, so a crash while saving no longer resets them.
- Variable frame rate clips, such as browser screen recordings, export at a normal speed and size with a speed ramp or the Fit quality setting.
- Lossless trims of WMV, OGV and other formats that MP4 cannot hold are offered only as MKV, so they no longer fail after the save dialog.
- Changing track volumes with Normalize on no longer leaves several loudness measurements running at once.
- Install this build on the Alpha channel installs on the first press.
- Quick Effects has a Redact effect. It hides parts of the frame with a blur, a pixelation or a black box. Add up to 8 boxes, drag each one on the picture to place it, and drag its corners to resize it.
- Redactions can be keyframed. Each keyframe sets a box's position, size and whether it shows. The box moves smoothly between keyframes, also in variable frame rate clips such as screen recordings. A lane under the timeline shows each redaction's keyframes: click one to jump to it, drag it to move it, and double-click or right-click it to remove it. The window grows to fit the lane, so the video keeps its size and place.
- Brightness, contrast, saturation, hue shift, blur, vignette and text opacity can each be keyframed on their own. Add a keyframe, move the playhead and change the setting, and the effect changes smoothly between keyframes. Untick "On here" to switch the effect off from a keyframe. Each keyframed effect gets its own row in the keyframe lane.

## 1.3.0-beta.4 - 2026-11-10

- Opening the audio tracks and the keyframe lane at the same moment no longer leaves the video unable to resize with the window.

## 1.3.0-beta.3 - 2026-11-10

- Switching several keyframed effects on or off quickly no longer leaves the video unable to resize with the window.

## 1.3.0-beta.2 - 2026-11-10

- The window grows to fit the keyframe lane under the timeline, so the video keeps its size and place.
- Moving redactions follow their path more closely in variable frame rate clips, such as screen recordings.

## 1.3.0-beta.1 - 2026-11-10

- Cancel now stops an export even when it is clicked in the first moments after Export, so the existing file is left alone.
- If a finished export cannot replace a locked or read-only file, it is kept beside it, and the message says where.
- Closing the window during an export no longer leaves a part-written file in the export folder.
- Export error messages keep FFmpeg's full explanation when the source has unusual text in its metadata.
- Update and FFmpeg downloads stop with an error and a Retry button when the connection stalls, instead of hanging.
- Checking for updates while one is downloading no longer interrupts the download, and the installer file can no longer be corrupted by two downloads at once.
- Automatic update checks run every hour as intended, not every two hours.
- The default output size setting is kept after a restart.
- Settings are saved safely, so a crash while saving no longer resets them.
- Variable frame rate clips, such as browser screen recordings, export at a normal speed and size with a speed ramp or the Fit quality setting.
- Lossless trims of WMV, OGV and other formats that MP4 cannot hold are offered only as MKV, so they no longer fail after the save dialog.
- Changing track volumes with Normalize on no longer leaves several loudness measurements running at once.
- Install this build on the Alpha channel installs on the first press.
- Quick Effects has a Redact effect. It hides parts of the frame with a blur, a pixelation or a black box. Add up to 8 boxes, drag each one on the picture to place it, and drag its corners to resize it.
- Redactions can be keyframed. Each keyframe sets a box's position, size and whether it shows. The box moves smoothly between keyframes. A lane under the timeline shows each redaction's keyframes: click one to jump to it, drag it to move it, and double-click or right-click it to remove it.
- Brightness, contrast, saturation, hue shift, blur, vignette and text opacity can each be keyframed on their own. Add a keyframe, move the playhead and change the setting, and the effect changes smoothly between keyframes. Untick "On here" to switch the effect off from a keyframe. Each keyframed effect gets its own row in the keyframe lane.

## 1.2.0 - 2026-10-02

- Exports can no longer overwrite the video you are editing, even when the chosen file reaches it through a hard link, a folder junction or a differently written path.
- A failed or cancelled export leaves any existing file at the destination untouched. The new export replaces it only after encoding finishes.
- Update checks no longer offer an equivalent build as a newer release.
- Beta installers use numbered versions and keep updating from older releases.

## 1.1.4-beta.2 - 2026-09-12

- Beta installers use numbered versions and preserve updates from older releases.

## 1.1.4-beta.1 - 2026-09-12

- Update checks no longer offer an equivalent build as a newer release.
