import { useRef, useCallback } from 'react';

const SAMPLE_RATE = 12000;
const BUFFER_SIZE = 4096;     // ScriptProcessorNode buffer (341ms at 12kHz)
const MAX_QUEUE_SAMPLES = SAMPLE_RATE * 2;  // drop if queue exceeds 2 seconds

export function useAudio() {
  const ctxRef        = useRef<AudioContext | null>(null);
  const gainRef       = useRef<GainNode | null>(null);
  const scriptRef     = useRef<ScriptProcessorNode | null>(null);
  const queueRef      = useRef<Float32Array[]>([]);
  const queueSizeRef  = useRef(0);
  // Server may output at a different rate than SAMPLE_RATE (e.g. 8000 or 10000 Hz
  // when the SDR sample rate isn't divisible by 12000). We resample on the fly.
  const serverRateRef = useRef(SAMPLE_RATE);

  const init = useCallback(() => {
    if (ctxRef.current) return;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const gain = ctx.createGain();
    gain.gain.value = 0.8;

    // ScriptProcessorNode: pulls from a queue for stutter-free continuous output.
    // Fills with silence when the queue is empty (avoids pops/gaps).
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const script = ctx.createScriptProcessor(BUFFER_SIZE, 0, 1);
    script.onaudioprocess = (e: AudioProcessingEvent) => {
      const out = e.outputBuffer.getChannelData(0);
      let pos = 0;
      while (pos < BUFFER_SIZE && queueRef.current.length > 0) {
        const chunk = queueRef.current[0];
        const needed = BUFFER_SIZE - pos;
        if (chunk.length <= needed) {
          out.set(chunk, pos);
          pos += chunk.length;
          queueRef.current.shift();
          queueSizeRef.current -= chunk.length;
        } else {
          out.set(chunk.subarray(0, needed), pos);
          queueRef.current[0] = chunk.subarray(needed);
          queueSizeRef.current -= needed;
          pos = BUFFER_SIZE;
        }
      }
      // Fill any remaining space with silence
      if (pos < BUFFER_SIZE) out.fill(0, pos);
    };

    script.connect(gain);
    gain.connect(ctx.destination);
    ctxRef.current  = ctx;
    gainRef.current = gain;
    scriptRef.current = script;
    // Some browsers start AudioContext suspended even on a user gesture
    ctx.resume().catch(() => {});
  }, []);

  const play = useCallback((samples: Int16Array) => {
    if (!ctxRef.current) return;

    const serverRate = serverRateRef.current;
    let floats: Float32Array;

    if (serverRate === SAMPLE_RATE) {
      // No resampling needed — KiwiSDR and servers that honour output_rate: 12000
      floats = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
    } else {
      // Linear interpolation resample from serverRate → SAMPLE_RATE
      const ratio  = SAMPLE_RATE / serverRate;
      const outLen = Math.round(samples.length * ratio);
      floats = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const src = i / ratio;
        const lo  = Math.floor(src);
        const hi  = Math.min(lo + 1, samples.length - 1);
        floats[i] = ((1 - (src - lo)) * samples[lo] + (src - lo) * samples[hi]) / 32768;
      }
    }

    queueRef.current.push(floats);
    queueSizeRef.current += floats.length;

    // Drop oldest chunks if buffer runs too far ahead (> 2 seconds)
    while (queueSizeRef.current > MAX_QUEUE_SAMPLES && queueRef.current.length > 1) {
      const dropped = queueRef.current.shift()!;
      queueSizeRef.current -= dropped.length;
    }
  }, []);

  const setServerRate = useCallback((rate: number) => {
    serverRateRef.current = rate;
    // Flush stale samples queued at the old rate to avoid a pitch blip on switch
    queueRef.current = [];
    queueSizeRef.current = 0;
  }, []);

  const setVolume = useCallback((v: number) => {
    if (gainRef.current) gainRef.current.gain.value = v;
  }, []);

  const stop = useCallback(() => {
    scriptRef.current?.disconnect();
    ctxRef.current?.close();
    ctxRef.current    = null;
    gainRef.current   = null;
    scriptRef.current = null;
    queueRef.current  = [];
    queueSizeRef.current = 0;
    serverRateRef.current = SAMPLE_RATE;
  }, []);

  return { init, play, stop, setVolume, setServerRate };
}
