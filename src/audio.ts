/**
 * Pushing the preview past what the <video> element can do on its own.
 *
 * element.volume caps at 1, so a boost - the whole point of normalising a quiet clip - is only
 * audible through a Web Audio gain node. createMediaElementSource reroutes an element
 * permanently and there is no way back, so the real element is attached only after a throwaway
 * one has proved the graph carries audio on this machine. Where it does not, nothing is
 * attached and the preview keeps its 100% ceiling.
 */

/** Long enough for a few hundred ms of decoded audio to reach the analyser. */
const PROBE_MS = 450;

/** Anything above the noise of an empty buffer counts; a real signal reads far higher. */
const PROBE_FLOOR = 0.0005;

let context: AudioContext | null = null;
let boost: GainNode | null = null;
let attaching = false;

/** null until a probe has come back positive; a zero reading is never cached, see probe(). */
let supported: boolean | null = null;

function rmsOf(analyser: AnalyserNode): number {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const x of buf) sum += x * x;
  return Math.sqrt(sum / buf.length);
}

/**
 * Plays a moment of the file into a graph that goes nowhere, and reports whether any of it
 * arrived. The element is thrown away either way, which is what makes this safe to run.
 */
async function graphCarriesAudio(src: string): Promise<boolean> {
  const probe = document.createElement('video');
  probe.crossOrigin = 'anonymous';
  probe.style.display = 'none';
  probe.preload = 'auto';
  document.body.appendChild(probe);

  let ctx: AudioContext | null = null;
  try {
    const loaded = new Promise<boolean>((resolve) => {
      probe.onloadeddata = () => resolve(true);
      probe.onerror = () => resolve(false);
      window.setTimeout(() => resolve(false), 6000);
    });
    probe.src = src;
    if (!(await loaded)) return false;

    ctx = new AudioContext();
    const source = ctx.createMediaElementSource(probe);
    const analyser = ctx.createAnalyser();
    // Silent output: the analyser sits ahead of a gain of zero, so the probe is inaudible.
    const silence = ctx.createGain();
    silence.gain.value = 0;
    source.connect(analyser);
    analyser.connect(silence);
    silence.connect(ctx.destination);

    await ctx.resume();
    await probe.play();
    await new Promise((resolve) => window.setTimeout(resolve, PROBE_MS));
    return rmsOf(analyser) > PROBE_FLOOR;
  } catch {
    return false;
  } finally {
    probe.pause();
    probe.remove();
    void ctx?.close();
  }
}

/**
 * Attaches the gain node, once, if the graph is known to work. Safe to call on every render:
 * it returns immediately after the first attempt resolves.
 */
/** Returns true only on the call that attached it, which is the caller's cue to re-render. */
export async function enableBoost(video: HTMLVideoElement, src: string): Promise<boolean> {
  if (boost || attaching || supported === false) return false;
  attaching = true;
  try {
    if (supported === null) {
      const carries = await graphCarriesAudio(src);
      // A silent clip reads the same as a blocked graph, so only a positive answer is kept.
      // A negative one is left unanswered and asked again on the next file.
      if (!carries) return false;
      supported = true;
    }
    context = new AudioContext();
    boost = context.createGain();
    context.createMediaElementSource(video).connect(boost);
    boost.connect(context.destination);
    return true;
  } catch {
    supported = false;
    return false;
  } finally {
    attaching = false;
  }
}

/**
 * Sets the preview gain by whichever route exists. Without the graph this is the old ceiling;
 * with it, the number is applied as asked.
 */
export function applyGain(video: HTMLVideoElement, gain: number): void {
  if (boost && context) {
    // The element stays at unity and the node does the work, so the two never multiply.
    if (video.volume !== 1) video.volume = 1;
    if (boost.gain.value !== gain) boost.gain.value = gain;
    if (context.state === 'suspended') void context.resume();
    return;
  }
  const capped = Math.min(gain, 1);
  if (video.volume !== capped) video.volume = capped;
}

/** Whether a boost above 100% is actually audible, for the UI to say so honestly. */
export function boostReady(): boolean {
  return boost !== null;
}
