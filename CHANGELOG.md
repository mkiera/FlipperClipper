# Changelog

## Unreleased

- Quick Effects has a Redact effect. It hides parts of the frame with a blur, a pixelation or a black box. Add up to 8 boxes, drag each one on the picture to place it, and drag its corners to resize it.
- Redactions can be keyframed. Each keyframe sets a box's position, size and whether it shows. The box moves smoothly between keyframes. A lane under the timeline shows each redaction's keyframes: click one to jump to it, drag it to move it, and double-click or right-click it to remove it.

## 1.2.0 - 2026-10-02

- Exports can no longer overwrite the video you are editing, even when the chosen file reaches it through a hard link, a folder junction or a differently written path.
- A failed or cancelled export leaves any existing file at the destination untouched. The new export replaces it only after encoding finishes.
- Update checks no longer offer an equivalent build as a newer release.
- Beta installers use numbered versions and keep updating from older releases.

## 1.1.4-beta.2 - 2026-09-12

- Beta installers use numbered versions and preserve updates from older releases.

## 1.1.4-beta.1 - 2026-09-12

- Update checks no longer offer an equivalent build as a newer release.
