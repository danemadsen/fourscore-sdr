import { useRef, useCallback } from 'react';

const SAMPLE_RATE = 12000;

export function useAudio() {
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const nextTimeRef = useRef<number>(0);

  const init = useCallback(() => {
    if (ctxRef.current) return;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const gain = ctx.createGain();
    gain.gain.value = 0.8;
    gain.connect(ctx.destination);
    ctxRef.current = ctx;
    gainRef.current = gain;
    nextTimeRef.current = ctx.currentTime;
  }, []);

  const play = useCallback((samples: Int16Array) => {
    const ctx = ctxRef.current;
    const gain = gainRef.current;
    if (!ctx || !gain) return;

    const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    const data = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      data[i] = samples[i] / 32768;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);

    const now = ctx.currentTime;
    // If we've fallen behind by more than 200ms, resync
    if (nextTimeRef.current < now - 0.2) {
      nextTimeRef.current = now + 0.05;
    }
    src.start(nextTimeRef.current);
    nextTimeRef.current += buf.duration;
  }, []);

  const setVolume = useCallback((v: number) => {
    if (gainRef.current) gainRef.current.gain.value = v;
  }, []);

  const stop = useCallback(() => {
    ctxRef.current?.close();
    ctxRef.current = null;
    gainRef.current = null;
  }, []);

  return { init, play, stop, setVolume };
}
