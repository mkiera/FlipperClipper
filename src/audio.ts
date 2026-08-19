/**
 * Pushing the preview past what the <video> element can do on its own.
 *
 * element.volume caps at 1, so a boost - the whole point of normalising a quiet clip - is only
 * audible through a Web Audio gain node. createMediaElementSource reroutes an element
 * permanently and there is no way back, so the real element is attached only after a throwaway
 * one has proved the graph carries audio on this machine. Where it does not, nothing is
 * attached and the preview keeps its 100% ceiling.
 *
 * The throwaway plays a tone this file generates, never the user's clip. Asking the clip was
 * the same question asked of the wrong thing: a clip quiet enough to want normalising, or one
 * that opens on a beat of silence, reads as no signal, and the boost it needs is refused every
 * time it is asked for.
 */

/** How long to keep looking for signal before calling the graph silent. */
const PROBE_TIMEOUT_MS = 1500;

/** Between reads: the analyser needs a render quantum or two of audio before it says anything. */
const PROBE_POLL_MS = 50;

/** Anything above the noise of an empty buffer counts; the probe tone reads near half scale. */
const PROBE_FLOOR = 0.0005;

/** resume() is left pending, not rejected, where autoplay policy will not start a context. */
const RESUME_TIMEOUT_MS = 1500;

const PROBE_HZ = 440;
const PROBE_RATE = 8000;
const PROBE_SECONDS = 2;
const PROBE_AMPLITUDE = 0.5;

let context: AudioContext | null = null;
let boost: GainNode | null = null;
let attaching = false;

/** null until the probe has run. Whether a graph carries audio is a property of the machine,
 *  so the answer holds for the session either way. */
let supported: boolean | null = null;

function rmsOf(analyser: AnalyserNode): number {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const x of buf) sum += x * x;
  return Math.sqrt(sum / buf.length);
}

/** A mono 16-bit WAV of a steady tone, as a blob URL a <video> element will play. */
function toneUrl(): string {
  const samples = PROBE_RATE * PROBE_SECONDS;
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // uncompressed
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, PROBE_RATE, true);
  view.setUint32(28, PROBE_RATE * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);

  for (let i = 0; i < samples; i += 1) {
    const value = Math.sin((2 * Math.PI * PROBE_HZ * i) / PROBE_RATE) * PROBE_AMPLITUDE;
    view.setInt16(44 + i * 2, value * 0x7fff, true);
  }

  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Plays a tone into a graph that goes nowhere, and reports whether any of it arrived. The
 * element is thrown away either way, which is what makes this safe to run.
 */
async function graphCarriesAudio(): Promise<boolean> {
  const url = toneUrl();
  const probe = document.createElement('audio');
  probe.preload = 'auto';
  probe.loop = true;
  probe.style.display = 'none';
  document.body.appendChild(probe);

  let ctx: AudioContext | null = null;
  try {
    const loaded = new Promise<boolean>((resolve) => {
      probe.onloadeddata = () => resolve(true);
      probe.onerror = () => resolve(false);
      window.setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
    });
    probe.src = url;
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

    await resumed(ctx);
    await probe.play();

    // Polled rather than read once: a single window landing early enough to be empty is the
    // same false negative the clip-based probe used to give.
    const until = performance.now() + PROBE_TIMEOUT_MS;
    while (performance.now() < until) {
      if (rmsOf(analyser) > PROBE_FLOOR) return true;
      await sleep(PROBE_POLL_MS);
    }
    return false;
  } catch {
    return false;
  } finally {
    probe.pause();
    probe.remove();
    URL.revokeObjectURL(url);
    void ctx?.close();
  }
}

/** resume() against a clock: without a gesture the promise neither resolves nor rejects, and
 *  the caller would hold `attaching` for the rest of the session waiting on it. */
async function resumed(ctx: AudioContext): Promise<void> {
  await Promise.race([ctx.resume(), sleep(RESUME_TIMEOUT_MS)]);
}

/**
 * Attaches the gain node, once, if the graph is known to work. Safe to call on every render:
 * it returns immediately after the first attempt resolves.
 */
/** Returns true only on the call that attached it, which is the caller's cue to re-render. */
export async function enableBoost(video: HTMLVideoElement): Promise<boolean> {
  if (boost || attaching || supported === false) return false;
  attaching = true;
  try {
    if (supported === null) supported = await graphCarriesAudio();
    if (!supported) return false;

    context = new AudioContext();
    boost = context.createGain();
    context.createMediaElementSource(video).connect(boost);
    boost.connect(context.destination);
    await resumed(context);
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
