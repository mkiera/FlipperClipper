//! The speed curve: how fast the clip runs at each moment, rather than all the way through.
//!
//! A ramp is a list of points on the source timeline, each a multiplier on the job's speed.
//! Between two points the multiplier moves linearly; outside them it holds. No points means a
//! flat 1, and every caller here falls back to the single-speed path it had before.
//!
//! Output time is the integral of 1/speed. Linear speed integrates to a logarithm, and the
//! closed form is what `setpts` is handed, so the file's length matches what src/ramp.ts
//! predicted for the preview and the size estimate down to frame quantisation.
//!
//! Audio cannot follow the same curve. `atempo` only takes one factor at a time, so the tempo
//! is stepped through the ramp by `asendcmd` instead. Measured on a 440 Hz sine: stepping
//! leaves the waveform continuous, where splitting the stream and concatenating per-segment
//! `atempo` put 22 discontinuities in it, some jumping two thirds of peak. The cost is that
//! `atempo` loses a sliver of audio at every tempo change, so the steps are kept coarse and
//! the result is padded back to the length the video works out to.

use serde::{Deserialize, Serialize};

/// Bounds on one point, matching the speed slider's own range in src/ramp.ts.
pub const RAMP_MIN: f64 = 0.05;
pub const RAMP_MAX: f64 = 20.0;

/// Two points closer than this are the same instant, and the segment between them integrates
/// to nothing worth emitting.
pub const RAMP_EPSILON: f64 = 0.001;

/// How long the audio holds one tempo inside a ramp. Every change costs a fraction of a
/// millisecond of audio: measured over a 60 s source, 0.1 s steps lost 123 ms and 0.5 s steps
/// lost 37 ms. Half a second is slow enough to keep that small and fast enough that the tempo
/// glide is not heard as a staircase.
pub const AUDIO_STEP_SECONDS: f64 = 0.5;

/// The most points a curve may carry. Each one nests another `if()` into the setpts
/// expression, and an expression ffmpeg cannot parse fails the export rather than the point.
pub const MAX_POINTS: usize = 24;

/// atempo takes 0.5 to 100 in one stage. The fixed part of the chain is set to the ramp's
/// slowest moment, so the varying stage runs from 1 upwards and only the top end can overrun.
pub const MAX_AUDIO_SPAN: f64 = 100.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedPoint {
    /// Seconds into the source, not into the trim.
    pub t: f64,
    /// Multiplier on the job's speed.
    pub speed: f64,
}

/// One piece of the curve, in time relative to the trim start - which is what ffmpeg sees,
/// because `-ss` before `-i` rebases the timestamps it hands the filter graph.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Segment {
    pub from: f64,
    pub to: f64,
    /// Effective speed, the job's speed already folded in.
    pub speed_from: f64,
    pub speed_to: f64,
}

impl Segment {
    fn is_flat(&self) -> bool {
        (self.speed_to - self.speed_from).abs() < 1e-6
    }
}

/// Whether the curve does anything. A curve of all 1s is the speed slider on its own, and
/// every path below leaves it to the code that was there before ramps existed.
pub fn has_ramp(points: &[SpeedPoint]) -> bool {
    points.iter().any(|p| (p.speed - 1.0).abs() > 1e-9)
}

/// The multiplier at a source time, holding flat outside the points.
pub fn multiplier_at(points: &[SpeedPoint], t: f64) -> f64 {
    let Some(first) = points.first() else {
        return 1.0;
    };
    if t <= first.t {
        return first.speed;
    }
    let last = points[points.len() - 1];
    if t >= last.t {
        return last.speed;
    }
    for pair in points.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if t <= b.t {
            let span = b.t - a.t;
            if span <= RAMP_EPSILON {
                return b.speed;
            }
            return a.speed + (b.speed - a.speed) * (t - a.t) / span;
        }
    }
    last.speed
}

/// The curve cut into flat and sloped pieces across the trim, rebased so the first starts at
/// zero. Every calculation below walks these, so the trim edges and the points outside it are
/// handled once here.
pub fn segments(points: &[SpeedPoint], base: f64, in_point: f64, out_point: f64) -> Vec<Segment> {
    let mut out = Vec::new();
    if !base.is_finite() || base <= 0.0 || out_point - in_point <= RAMP_EPSILON {
        return out;
    }

    let mut cuts = vec![in_point];
    for point in points {
        if point.t > in_point + RAMP_EPSILON && point.t < out_point - RAMP_EPSILON {
            cuts.push(point.t);
        }
    }
    cuts.push(out_point);

    for pair in cuts.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if b - a <= RAMP_EPSILON {
            continue;
        }
        out.push(Segment {
            from: a - in_point,
            to: b - in_point,
            speed_from: base * multiplier_at(points, a),
            speed_to: base * multiplier_at(points, b),
        });
    }
    out
}

/// How long one piece lasts in the finished clip. A flat piece divides; a sloped one
/// integrates to a logarithm, which is exact rather than a fine-enough sum of slices.
pub fn segment_output(segment: &Segment) -> f64 {
    let span = segment.to - segment.from;
    if span <= 0.0 || segment.speed_from <= 0.0 || segment.speed_to <= 0.0 {
        return 0.0;
    }
    if segment.is_flat() {
        return span / segment.speed_from;
    }
    (span / (segment.speed_to - segment.speed_from)) * (segment.speed_to / segment.speed_from).ln()
}

/// The finished clip's length under the curve.
pub fn ramped_duration(points: &[SpeedPoint], base: f64, in_point: f64, out_point: f64) -> f64 {
    segments(points, base, in_point, out_point)
        .iter()
        .map(segment_output)
        .sum::<f64>()
        .max(0.0)
}

/// The slowest and fastest the clip actually runs, for the checks that need to know whether a
/// filter can follow the whole curve.
pub fn speed_bounds(segments: &[Segment]) -> Option<(f64, f64)> {
    let mut lo = f64::INFINITY;
    let mut hi: f64 = 0.0;
    for segment in segments {
        lo = lo.min(segment.speed_from).min(segment.speed_to);
        hi = hi.max(segment.speed_from).max(segment.speed_to);
    }
    (lo.is_finite() && hi > 0.0).then_some((lo, hi))
}

/// The `setpts` value: output time as a function of `T`, the input timestamp in seconds.
///
/// Nested `if()`s, one per piece, each mapping its own stretch of input time. The last piece
/// is the final else, so a frame past the end extends its slope rather than falling off.
pub fn setpts_expression(segments: &[Segment]) -> Option<String> {
    let last = segments.len().checked_sub(1)?;

    let mut offset = 0.0;
    let mut offsets = Vec::with_capacity(segments.len());
    for segment in segments {
        offsets.push(offset);
        offset += segment_output(segment);
    }

    let mut expr = branch(&segments[last], offsets[last]);
    for i in (0..last).rev() {
        expr = format!(
            "if(lt(T,{}),{},{})",
            num(segments[i].to),
            branch(&segments[i], offsets[i]),
            expr
        );
    }
    Some(expr)
}

/// One piece's contribution: where output time sits partway through it.
fn branch(segment: &Segment, offset: f64) -> String {
    if segment.is_flat() {
        return format!(
            "{}+(T-{})/{}",
            num(offset),
            num(segment.from),
            num(segment.speed_from)
        );
    }
    // Speed is s0 + k(T-from), so the integral of 1/speed is ln(speed/s0)/k.
    let k = (segment.speed_to - segment.speed_from) / (segment.to - segment.from);
    format!(
        "{}+{}*log(({}+{}*(T-{}))/{})",
        num(offset),
        num(1.0 / k),
        num(segment.speed_from),
        num(k),
        num(segment.from),
        num(segment.speed_from)
    )
}

/// The audio chain for a ramp: the tempo stepped through each slope, flat pieces left as one
/// command apiece.
///
/// The fixed stages carry the ramp's slowest speed and the driven stage carries what is left,
/// so the driven one starts at 1 and only ever climbs - which keeps it inside the single range
/// atempo accepts without the chain having to change shape partway through the clip.
pub fn audio_stages(segments: &[Segment], step: f64) -> Option<Vec<String>> {
    let (lo, hi) = speed_bounds(segments)?;
    if lo <= 0.0 || hi / lo > MAX_AUDIO_SPAN {
        return None;
    }

    let mut commands: Vec<String> = Vec::new();
    let mut push = |at: f64, speed: f64| {
        commands.push(format!(
            "{} atempo@ramp tempo {}",
            num(at.max(0.0)),
            num(speed / lo)
        ));
    };

    for segment in segments {
        if segment.is_flat() {
            push(segment.from, segment.speed_from);
            continue;
        }
        let mut t = segment.from;
        while t < segment.to - 1e-9 {
            let end = (t + step).min(segment.to);
            // Sampled at the midpoint: the step's error against the true curve cancels either
            // side of it, where sampling the start would run the whole step slow.
            let mid = (t + end) / 2.0;
            let fraction = (mid - segment.from) / (segment.to - segment.from);
            push(
                t,
                segment.speed_from + (segment.speed_to - segment.speed_from) * fraction,
            );
            t = end;
        }
    }
    if commands.is_empty() {
        return None;
    }

    let initial = commands
        .first()
        .and_then(|c| c.rsplit(' ').next())
        .unwrap_or("1")
        .to_string();

    let mut stages = vec![format!("asendcmd=c='{}'", commands.join(";"))];
    stages.extend(crate::ffmpeg::atempo_chain(lo));
    stages.push(format!("atempo@ramp={}", initial));
    Some(stages)
}

/// Six decimals, trailing zeros trimmed. Matches ffmpeg.rs's own formatting so a ramp reads
/// like the rest of the graph.
fn num(v: f64) -> String {
    let mut s = format!("{:.6}", v);
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.push('0');
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn points(pairs: &[(f64, f64)]) -> Vec<SpeedPoint> {
        pairs.iter().map(|(t, speed)| SpeedPoint { t: *t, speed: *speed }).collect()
    }

    /// The commands back out of the `asendcmd=c='...'` the stage wraps them in.
    fn commands_in(stage: &str) -> Vec<&str> {
        stage
            .trim_start_matches("asendcmd=c='")
            .trim_end_matches('\'')
            .split(';')
            .collect()
    }

    #[test]
    fn an_empty_curve_is_the_speed_slider_on_its_own() {
        assert!(!has_ramp(&[]));
        assert!(!has_ramp(&points(&[(0.0, 1.0), (5.0, 1.0)])));
        assert!(has_ramp(&points(&[(0.0, 1.0), (5.0, 2.0)])));
        assert_eq!(multiplier_at(&[], 3.0), 1.0);
    }

    #[test]
    fn the_multiplier_holds_flat_outside_the_points() {
        let p = points(&[(2.0, 1.0), (4.0, 3.0)]);
        assert_eq!(multiplier_at(&p, 0.0), 1.0);
        assert_eq!(multiplier_at(&p, 2.0), 1.0);
        assert_eq!(multiplier_at(&p, 3.0), 2.0);
        assert_eq!(multiplier_at(&p, 4.0), 3.0);
        assert_eq!(multiplier_at(&p, 9.0), 3.0);
    }

    #[test]
    fn a_flat_curve_divides_the_trim_the_way_one_speed_would() {
        let d = ramped_duration(&[], 2.0, 10.0, 20.0);
        assert!((d - 5.0).abs() < 1e-9, "{d}");
    }

    #[test]
    fn a_ramp_integrates_rather_than_averaging_its_ends() {
        // 1x to 4x over 2 seconds. The mean of the ends would say 2/2.5 = 0.8s; the integral
        // of 1/speed says (2/3)ln(4) = 0.924s, and the file is the length of the integral.
        let p = points(&[(0.0, 1.0), (2.0, 4.0)]);
        let d = ramped_duration(&p, 1.0, 0.0, 2.0);
        assert!((d - (2.0 / 3.0) * 4.0_f64.ln()).abs() < 1e-9, "{d}");
        assert!(d > 0.8, "the integral must exceed the average of the ends");
    }

    #[test]
    fn the_job_speed_multiplies_through_the_whole_curve() {
        let p = points(&[(0.0, 1.0), (2.0, 4.0)]);
        let single = ramped_duration(&p, 1.0, 0.0, 2.0);
        let doubled = ramped_duration(&p, 2.0, 0.0, 2.0);
        assert!((doubled - single / 2.0).abs() < 1e-9, "{doubled} vs {single}");
    }

    #[test]
    fn segments_are_rebased_onto_the_trim() {
        // ffmpeg's -ss rebases timestamps, so a point 12s into the source is 2s into the graph.
        let p = points(&[(10.0, 1.0), (12.0, 2.0)]);
        let segs = segments(&p, 1.0, 10.0, 14.0);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].from, 0.0);
        assert_eq!(segs[0].to, 2.0);
        assert_eq!(segs[1].to, 4.0);
        // Held flat past the last point.
        assert_eq!(segs[1].speed_from, 2.0);
        assert_eq!(segs[1].speed_to, 2.0);
    }

    #[test]
    fn a_point_outside_the_trim_still_bends_the_speed_inside_it() {
        // The curve is a property of the source, so trimming into the middle of a ramp starts
        // partway up it rather than at 1x.
        let p = points(&[(0.0, 1.0), (10.0, 3.0)]);
        let segs = segments(&p, 1.0, 5.0, 6.0);
        assert_eq!(segs.len(), 1);
        assert!((segs[0].speed_from - 2.0).abs() < 1e-9, "{:?}", segs[0]);
        assert!((segs[0].speed_to - 2.2).abs() < 1e-9, "{:?}", segs[0]);
    }

    #[test]
    fn a_flat_curve_emits_a_plain_division_rather_than_a_logarithm() {
        let segs = segments(&[], 2.0, 0.0, 5.0);
        let expr = setpts_expression(&segs).expect("a flat curve still has one segment");
        assert!(!expr.contains("log"), "{expr}");
        assert!(expr.contains("/2.0"), "{expr}");
    }

    #[test]
    fn the_expression_nests_one_branch_per_segment() {
        let p = points(&[(0.0, 1.0), (2.0, 4.0), (4.0, 4.0)]);
        let segs = segments(&p, 1.0, 0.0, 6.0);
        let expr = setpts_expression(&segs).expect("three segments");
        assert_eq!(segs.len(), 3);
        assert_eq!(expr.matches("if(lt(T,").count(), 2, "{expr}");
        assert_eq!(expr.matches("log(").count(), 1, "{expr}");
    }

    /// The expression is what ffmpeg will evaluate, so evaluating it here is the only check
    /// that the arithmetic in `branch` matches the integral in `segment_output`.
    fn eval(segments: &[Segment], t: f64) -> f64 {
        let mut offset = 0.0;
        for segment in segments {
            if t < segment.to || std::ptr::eq(segment, &segments[segments.len() - 1]) {
                let part = Segment { to: t.min(segment.to), ..*segment };
                let part = if segment.is_flat() {
                    (part.to - part.from) / part.speed_from
                } else {
                    let k = (segment.speed_to - segment.speed_from) / (segment.to - segment.from);
                    let at = segment.speed_from + k * (part.to - part.from);
                    (1.0 / k) * (at / segment.speed_from).ln()
                };
                return offset + part;
            }
            offset += segment_output(segment);
        }
        offset
    }

    #[test]
    fn the_expression_lands_on_the_same_duration_the_integral_predicts() {
        let p = points(&[(0.0, 1.0), (3.0, 1.0), (5.0, 4.0), (8.0, 4.0), (10.0, 1.0)]);
        let segs = segments(&p, 1.0, 0.0, 10.0);
        let predicted = ramped_duration(&p, 1.0, 0.0, 10.0);
        let walked = eval(&segs, 10.0);
        assert!((walked - predicted).abs() < 1e-9, "{walked} vs {predicted}");
        // The measured render of exactly this curve came out at 5.6s against 5.598392.
        assert!((predicted - 5.598392).abs() < 1e-5, "{predicted}");
    }

    #[test]
    fn a_flat_stretch_costs_one_tempo_command_however_long_it_is() {
        // Every tempo change loses a sliver of audio, so a constant section must not be
        // stepped just because it sits beside a ramp.
        let p = points(&[(0.0, 1.0), (60.0, 1.0)]);
        let segs = segments(&p, 1.0, 0.0, 60.0);
        let stages = audio_stages(&segs, AUDIO_STEP_SECONDS).expect("a flat curve still steps");
        assert_eq!(stages[0].matches(';').count(), 0, "{}", stages[0]);
    }

    #[test]
    fn a_slope_is_stepped_at_the_audio_interval() {
        let p = points(&[(0.0, 1.0), (4.0, 2.0)]);
        let segs = segments(&p, 1.0, 0.0, 4.0);
        let stages = audio_stages(&segs, AUDIO_STEP_SECONDS).expect("a slope steps");
        // Four seconds at half-second steps.
        assert_eq!(stages[0].matches(';').count(), 7, "{}", stages[0]);
    }

    #[test]
    fn the_driven_stage_starts_at_one_and_the_fixed_stages_carry_the_slow_end() {
        // atempo refuses anything under 0.5, so a quarter-speed ramp has to put the 0.25 into
        // fixed stages and drive only what is left.
        let p = points(&[(0.0, 0.25), (4.0, 1.0)]);
        let segs = segments(&p, 1.0, 0.0, 4.0);
        let stages = audio_stages(&segs, AUDIO_STEP_SECONDS).expect("a slow ramp still steps");
        let joined = stages.join(",");
        assert!(joined.contains("atempo=0.5"), "{joined}");
        assert!(joined.contains("atempo@ramp="), "{joined}");
        // Nothing driven below atempo's floor.
        for command in commands_in(&stages[0]) {
            let tempo: f64 = command.rsplit(' ').next().unwrap().parse().unwrap();
            assert!(tempo >= 0.5, "{command}");
        }
    }

    #[test]
    fn a_curve_wider_than_atempo_can_follow_is_refused_rather_than_clipped() {
        let p = points(&[(0.0, 0.05), (4.0, 20.0)]);
        let segs = segments(&p, 1.0, 0.0, 4.0);
        assert!(speed_bounds(&segs).is_some());
        assert!(audio_stages(&segs, AUDIO_STEP_SECONDS).is_none());
    }
}
