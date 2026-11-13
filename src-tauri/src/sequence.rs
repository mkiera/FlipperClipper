//! Several clips joined into one timeline. Each clip is its own `-ss`/`-t`/`-i` input, and a
//! filter graph fits every clip to one frame size, frame rate and audio format, then joins them
//! with `concat`. What comes out is labelled `[sv]` for the picture and `[sa<N>]` for audio
//! track N, and from there the export treats it exactly as it treats one trimmed file: it
//! starts at 0, which is the job's in point on the timeline.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// The most clips one export takes. Each adds an input and a few hundred characters of filter
/// graph, and Windows refuses a command line past 32,767 characters.
pub const MAX_CLIPS: usize = 32;

/// What every clip's audio is converted to before the join, because concat takes one format.
const SAMPLE_RATE: u32 = 48_000;

/// Shorter than this a clip left after the trim is a rounding error, not footage.
const MIN_PIECE_SECONDS: f64 = 0.001;

/// One stretch of a file, as the UI sends it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipPiece {
    pub path: String,
    /// Seconds into the file.
    pub start: f64,
    pub end: f64,
}

/// A clip with the audio track count its file was probed to have.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedClip {
    pub path: String,
    pub start: f64,
    pub end: f64,
    pub audio_tracks: usize,
}

impl PlannedClip {
    pub fn duration(&self) -> f64 {
        (self.end - self.start).max(0.0)
    }
}

/// The frame every clip is fitted into: the largest clip's, made even for yuv420p.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Canvas {
    pub width: i64,
    pub height: i64,
    pub fps: f64,
}

impl Canvas {
    pub fn new(width: i64, height: i64, fps: f64) -> Self {
        let even = |v: i64| (v.max(2) / 2) * 2;
        let fps = if fps.is_finite() && fps > 0.0 { fps.min(240.0) } else { 30.0 };
        Self { width: even(width), height: even(height), fps }
    }
}

pub fn validate_clips(clips: &[ClipPiece]) -> Result<(), String> {
    if clips.len() > MAX_CLIPS {
        return Err(format!("An export can join at most {MAX_CLIPS} clips."));
    }
    for clip in clips {
        if !clip.start.is_finite() || !clip.end.is_finite() || clip.start < 0.0 || clip.end <= clip.start {
            return Err("A clip on the timeline has an empty or invalid range.".to_string());
        }
        if !Path::new(&clip.path).is_file() {
            return Err(format!(
                "A clip's file is no longer there. It may have been moved or deleted: {}",
                clip.path
            ));
        }
    }
    Ok(())
}

pub fn total_duration(clips: &[PlannedClip]) -> f64 {
    clips.iter().map(PlannedClip::duration).sum()
}

/// The part of the timeline between `from` and `to`, as clips. A clip the window cuts through
/// is shortened, and one outside it is left out.
pub fn window(clips: &[PlannedClip], from: f64, to: f64) -> Vec<PlannedClip> {
    let mut out = Vec::new();
    let mut at = 0.0;
    for clip in clips {
        let length = clip.duration();
        let (clip_from, clip_to) = (at, at + length);
        at = clip_to;
        let lo = from.max(clip_from);
        let hi = to.min(clip_to);
        if hi - lo < MIN_PIECE_SECONDS {
            continue;
        }
        out.push(PlannedClip {
            start: clip.start + (lo - clip_from),
            end: clip.start + (hi - clip_from),
            ..clip.clone()
        });
    }
    out
}

fn fmt_time(v: f64) -> String {
    format!("{:.3}", v.max(0.0))
}

fn fmt_rate(v: f64) -> String {
    let mut s = format!("{:.6}", v);
    while s.ends_with('0') && !s.ends_with(".0") {
        s.pop();
    }
    s
}

/// One input per clip. `-ss` ahead of `-i` seeks to the keyframe before and decodes forward,
/// so the cut is frame-accurate and each input's timestamps start at 0.
pub fn input_args(clips: &[PlannedClip]) -> Vec<String> {
    let mut args = Vec::new();
    for clip in clips {
        args.push("-ss".to_string());
        args.push(fmt_time(clip.start));
        args.push("-t".to_string());
        args.push(fmt_time(clip.duration()));
        args.push("-i".to_string());
        args.push(clip.path.clone());
    }
    args
}

/// The joining graph. With a canvas it carries the picture out as `[sv]`, and each index in
/// `tracks` comes out as `[sa<index>]`. A clip without that track plays silence there, so a
/// clip recorded without a mic does not take the mic track out of the others.
pub fn graph(clips: &[PlannedClip], canvas: Option<Canvas>, tracks: &[usize]) -> String {
    let mut stages: Vec<String> = Vec::new();
    let mut joined = String::new();
    for (i, clip) in clips.iter().enumerate() {
        let duration = fmt_time(clip.duration());
        if let Some(c) = canvas {
            // Fitted inside the canvas and centred on black, the way a player letterboxes it.
            stages.push(format!(
                "[{i}:v:0]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},format=yuv420p[v{i}]",
                w = c.width,
                h = c.height,
                fps = fmt_rate(c.fps),
            ));
            joined.push_str(&format!("[v{i}]"));
        }
        for &track in tracks {
            let label = format!("a{i}_{track}");
            // Padded and cut to the clip's length, so the picture and sound of the next clip
            // start together however short this clip's audio ran.
            let source = if track < clip.audio_tracks {
                format!("[{i}:a:{track}]aresample={SAMPLE_RATE}:async=1:first_pts=0")
            } else {
                format!("anullsrc=r={SAMPLE_RATE}:cl=stereo")
            };
            stages.push(format!(
                "{source},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end={duration},asetpts=N/SR/TB[{label}]"
            ));
            joined.push_str(&format!("[{label}]"));
        }
    }
    let mut outputs = String::new();
    if canvas.is_some() {
        outputs.push_str("[sv]");
    }
    for &track in tracks {
        outputs.push_str(&format!("[sa{track}]"));
    }
    stages.push(format!(
        "{joined}concat=n={}:v={}:a={}{outputs}",
        clips.len(),
        usize::from(canvas.is_some()),
        tracks.len()
    ));
    stages.join(";")
}

/// The most audio tracks any clip has.
pub fn track_count(clips: &[PlannedClip]) -> usize {
    clips.iter().map(|clip| clip.audio_tracks).max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(path: &str, start: f64, end: f64, tracks: usize) -> PlannedClip {
        PlannedClip { path: path.to_string(), start, end, audio_tracks: tracks }
    }

    #[test]
    fn window_keeps_only_the_trimmed_part_of_the_timeline() {
        let clips = [clip("a.mp4", 10.0, 20.0, 1), clip("b.mp4", 0.0, 5.0, 1), clip("a.mp4", 0.0, 4.0, 1)];
        // Timeline: a[10,20] at 0-10, b[0,5] at 10-15, a[0,4] at 15-19.
        let cut = window(&clips, 8.0, 16.0);
        assert_eq!(cut, vec![clip("a.mp4", 18.0, 20.0, 1), clip("b.mp4", 0.0, 5.0, 1), clip("a.mp4", 0.0, 1.0, 1)]);
        assert!((total_duration(&cut) - 8.0).abs() < 1e-9);
    }

    #[test]
    fn window_over_the_whole_timeline_is_every_clip() {
        let clips = [clip("a.mp4", 0.0, 3.0, 2), clip("b.mp4", 1.0, 2.0, 0)];
        assert_eq!(window(&clips, 0.0, 4.0), clips.to_vec());
    }

    #[test]
    fn a_window_edge_on_a_clip_edge_leaves_no_sliver() {
        let clips = [clip("a.mp4", 0.0, 3.0, 1), clip("b.mp4", 0.0, 3.0, 1)];
        assert_eq!(window(&clips, 3.0, 6.0), vec![clip("b.mp4", 0.0, 3.0, 1)]);
    }

    #[test]
    fn each_clip_is_its_own_seeked_input() {
        let clips = [clip("a.mp4", 1.5, 4.0, 1), clip("b.mkv", 0.0, 2.0, 1)];
        assert_eq!(
            input_args(&clips),
            ["-ss", "1.500", "-t", "2.500", "-i", "a.mp4", "-ss", "0.000", "-t", "2.000", "-i", "b.mkv"]
        );
    }

    #[test]
    fn the_graph_fits_every_clip_to_the_canvas_and_joins_picture_and_sound() {
        let clips = [clip("a.mp4", 0.0, 2.0, 1), clip("b.mp4", 0.0, 3.0, 1)];
        let g = graph(&clips, Some(Canvas::new(1920, 1080, 60.0)), &[0]);
        assert!(g.contains("[0:v:0]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:"));
        assert!(g.contains("[1:v:0]scale=1920:1080"));
        assert!(g.contains("fps=60.0,format=yuv420p[v1]"));
        assert!(g.contains("[1:a:0]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end=3.000,asetpts=N/SR/TB[a1_0]"));
        assert!(g.ends_with("[v0][a0_0][v1][a1_0]concat=n=2:v=1:a=1[sv][sa0]"));
    }

    #[test]
    fn a_clip_missing_a_track_plays_silence_on_it() {
        let clips = [clip("six.mkv", 0.0, 2.0, 6), clip("one.mp4", 0.0, 1.0, 1)];
        let g = graph(&clips, None, &[0, 4]);
        assert!(g.contains("[0:a:4]aresample"));
        assert!(g.contains("[1:a:0]aresample"));
        assert!(g.contains("anullsrc=r=48000:cl=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end=1.000,asetpts=N/SR/TB[a1_4]"));
        assert!(!g.contains("[1:a:4]"));
        assert!(g.ends_with("[a0_0][a0_4][a1_0][a1_4]concat=n=2:v=0:a=2[sa0][sa4]"));
    }

    #[test]
    fn a_picture_only_join_has_no_audio_stages() {
        let clips = [clip("a.mp4", 0.0, 2.0, 1)];
        let g = graph(&clips, Some(Canvas::new(1280, 720, 30.0)), &[]);
        assert!(!g.contains("aresample"));
        assert!(g.ends_with("[v0]concat=n=1:v=1:a=0[sv]"));
    }

    #[test]
    fn the_canvas_is_even_and_has_a_usable_rate() {
        assert_eq!(Canvas::new(1081, 607, 0.0), Canvas { width: 1080, height: 606, fps: 30.0 });
        assert_eq!(Canvas::new(1920, 1080, 1000.0).fps, 240.0);
    }

    #[test]
    fn the_track_count_is_the_most_any_clip_has() {
        assert_eq!(track_count(&[clip("a", 0.0, 1.0, 1), clip("b", 0.0, 1.0, 6)]), 6);
        assert_eq!(track_count(&[]), 0);
    }

    #[test]
    fn clips_are_validated_before_anything_runs() {
        let missing = ClipPiece { path: "Z:/nowhere/clip.mp4".to_string(), start: 0.0, end: 1.0 };
        assert!(validate_clips(&[missing]).is_err());
        let backwards = ClipPiece { path: file!().to_string(), start: 2.0, end: 1.0 };
        assert!(validate_clips(&[backwards]).is_err());
        let too_many = vec![ClipPiece { path: file!().to_string(), start: 0.0, end: 1.0 }; MAX_CLIPS + 1];
        assert!(validate_clips(&too_many).is_err());
    }
}
