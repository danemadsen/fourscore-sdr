import { useRef, useCallback } from 'react';

const DEFAULT_OUTPUT_RATE = 12000;
const MAX_QUEUE_SECONDS = 2;
const GOOD_SAMPLE_RATES = [48000, 44100, 96000] as const;

class Lowpass {
  private readonly interpolation: number;
  private readonly numTaps: number;
  private readonly coefficients: number[];
  private readonly delay: Float32Array;
  private delayIndex = 0;

  constructor(interpolation: number) {
    this.interpolation = interpolation;
    const transitionBandwidth = 0.05;
    let taps = Math.round(4 / transitionBandwidth);
    if (taps % 2 === 0) taps += 1;
    this.numTaps = taps;
    const cutoff = 1 / interpolation;
    this.coefficients = this.getCoefficients(cutoff / 2);
    this.delay = new Float32Array(this.numTaps);
  }

  private getCoefficients(cutoffRate: number): number[] {
    const middle = Math.floor(this.numTaps / 2);
    const output = new Array<number>(this.numTaps);
    const windowFunction = (r: number) => {
      const rate = 0.5 + r / 2;
      return 0.54 - 0.46 * Math.cos(2 * Math.PI * rate);
    };

    output[middle] = 2 * Math.PI * cutoffRate * windowFunction(0);
    for (let i = 1; i <= middle; i++) {
      const value = (Math.sin(2 * Math.PI * cutoffRate * i) / i) * windowFunction(i / middle);
      output[middle - i] = value;
      output[middle + i] = value;
    }
    return this.normalizeCoefficients(output);
  }

  private normalizeCoefficients(input: number[]): number[] {
    const sum = input.reduce((acc, value) => acc + value, 0);
    return input.map(value => value / sum);
  }

  process(input: Float32Array): Float32Array {
    const output = new Float32Array(input.length);
    for (let oi = 0; oi < input.length; oi++) {
      this.delay[this.delayIndex] = input[oi];
      this.delayIndex = (this.delayIndex + 1) % this.numTaps;

      let acc = 0;
      let index = this.delayIndex;
      for (let i = 0; i < this.numTaps; i++) {
        index = index !== 0 ? index - 1 : this.numTaps - 1;
        acc += this.delay[index] * this.coefficients[i];
      }
      output[oi] = this.interpolation * acc;
    }
    return output;
  }
}

class Interpolator {
  private readonly factor: number;
  private readonly lowpass: Lowpass;

  constructor(factor: number) {
    this.factor = factor;
    this.lowpass = new Lowpass(factor);
  }

  process(data: Int16Array): Float32Array {
    const output = new Float32Array(data.length * this.factor);
    for (let i = 0; i < data.length; i++) {
      output[i * this.factor] = (data[i] + 0.5) / 32768;
    }
    return this.lowpass.process(output);
  }
}

function createPreferredAudioContext(): AudioContext {
  const AudioContextClass = window.AudioContext
    ?? (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio API is not supported in this browser');

  let ctx = new AudioContextClass({ latencyHint: 'playback' });
  if (GOOD_SAMPLE_RATES.includes(ctx.sampleRate as typeof GOOD_SAMPLE_RATES[number])) return ctx;

  ctx.close().catch(() => {});
  for (const sampleRate of GOOD_SAMPLE_RATES) {
    try {
      ctx = new AudioContextClass({ sampleRate, latencyHint: 'playback' });
      return ctx;
    } catch {
      // Try the next preferred sample rate.
    }
  }

  return new AudioContextClass({ latencyHint: 'playback' });
}

function findOutputRate(targetRate: number): { outputRate: number; factor: number } {
  let factor = 1;
  while (true) {
    const outputRate = Math.floor(targetRate / factor);
    if (outputRate < 8000) break;
    if (outputRate <= 12000) return { outputRate, factor };
    factor++;
  }
  return { outputRate: DEFAULT_OUTPUT_RATE, factor: Math.max(1, Math.round(targetRate / DEFAULT_OUTPUT_RATE)) };
}

function getBufferSize(sampleRate: number): number {
  if (sampleRate < 44100 * 2) return 4096;
  if (sampleRate < 44100 * 4) return 8192;
  return 16384;
}

export function useAudio() {
  const ctxRef        = useRef<AudioContext | null>(null);
  const gainRef       = useRef<GainNode | null>(null);
  const workletRef    = useRef<AudioWorkletNode | null>(null);
  const scriptRef     = useRef<ScriptProcessorNode | null>(null);
  const queueRef      = useRef<Float32Array[]>([]);
  const queueSizeRef  = useRef(0);
  const outputRateRef = useRef(DEFAULT_OUTPUT_RATE);
  const maxQueueSamplesRef = useRef(DEFAULT_OUTPUT_RATE * MAX_QUEUE_SECONDS);
  const interpolatorRef = useRef<Interpolator | null>(null);
  const passthroughRef = useRef(true);

  const init = useCallback(() => {
    if (ctxRef.current) return;

    const ctx = createPreferredAudioContext();
    const { outputRate, factor } = findOutputRate(ctx.sampleRate);
    const bufferSize = getBufferSize(ctx.sampleRate);

    const gain = ctx.createGain();
    gain.gain.value = 0.8;
    outputRateRef.current = outputRate;
    maxQueueSamplesRef.current = ctx.sampleRate * MAX_QUEUE_SECONDS;
    passthroughRef.current = factor === 1;
    interpolatorRef.current = factor > 1 ? new Interpolator(factor) : null;

    const connectScriptProcessor = () => {
      if (scriptRef.current || workletRef.current || ctxRef.current !== ctx) return;
      // ScriptProcessorNode fallback: pulls from the shared queue on the main thread.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const script = ctx.createScriptProcessor(bufferSize, 0, 1);
      script.onaudioprocess = (e: AudioProcessingEvent) => {
        const out = e.outputBuffer.getChannelData(0);
        let pos = 0;
        while (pos < bufferSize && queueRef.current.length > 0) {
          const chunk = queueRef.current[0];
          const needed = bufferSize - pos;
          if (chunk.length <= needed) {
            out.set(chunk, pos);
            pos += chunk.length;
            queueRef.current.shift();
            queueSizeRef.current -= chunk.length;
          } else {
            out.set(chunk.subarray(0, needed), pos);
            queueRef.current[0] = chunk.subarray(needed);
            queueSizeRef.current -= needed;
            pos = bufferSize;
          }
        }
        if (pos < bufferSize) out.fill(0, pos);
      };
      script.connect(gain);
      scriptRef.current = script;
    };

    ctxRef.current  = ctx;
    gainRef.current = gain;
    gain.connect(ctx.destination);

    if (ctx.audioWorklet) {
      const processorUrl = `${import.meta.env.BASE_URL}AudioProcessor.js`;
      ctx.audioWorklet.addModule(processorUrl).then(() => {
        if (ctxRef.current !== ctx || workletRef.current) return;
        const node = new AudioWorkletNode(ctx, 'openwebrx-audio-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: {
            maxBufferSize: maxQueueSamplesRef.current,
          },
        });
        node.connect(gain);
        workletRef.current = node;

        while (queueRef.current.length > 0) {
          node.port.postMessage(queueRef.current.shift()!);
        }
        queueSizeRef.current = 0;
      }).catch(() => {
        connectScriptProcessor();
      });
    } else {
      connectScriptProcessor();
    }

    // Some browsers start AudioContext suspended even on a user gesture
    ctx.resume().catch(() => {});
  }, []);

  const play = useCallback((samples: Int16Array) => {
    if (!ctxRef.current) return;

    let floats: Float32Array;
    if (passthroughRef.current) {
      floats = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
    } else {
      floats = interpolatorRef.current!.process(samples);
    }

    if (workletRef.current) {
      workletRef.current.port.postMessage(floats);
      return;
    }

    queueRef.current.push(floats);
    queueSizeRef.current += floats.length;

    // Drop oldest chunks if buffer runs too far ahead (> 2 seconds)
    while (queueSizeRef.current > maxQueueSamplesRef.current && queueRef.current.length > 1) {
      const dropped = queueRef.current.shift()!;
      queueSizeRef.current -= dropped.length;
    }
  }, []);

  const setServerRate = useCallback((_rate: number) => {
    // OpenWebRX's negotiated output_rate is treated as authoritative. Estimating
    // the sample rate from packet timing introduced audible distortion.
  }, []);

  const setVolume = useCallback((v: number) => {
    if (gainRef.current) gainRef.current.gain.value = v;
  }, []);

  const stop = useCallback(() => {
    workletRef.current?.disconnect();
    scriptRef.current?.disconnect();
    ctxRef.current?.close();
    ctxRef.current    = null;
    gainRef.current   = null;
    workletRef.current = null;
    scriptRef.current = null;
    outputRateRef.current = DEFAULT_OUTPUT_RATE;
    maxQueueSamplesRef.current = DEFAULT_OUTPUT_RATE * MAX_QUEUE_SECONDS;
    interpolatorRef.current = null;
    passthroughRef.current = true;
    queueRef.current  = [];
    queueSizeRef.current = 0;
  }, []);

  const getOutputRate = useCallback(() => outputRateRef.current, []);

  return { init, play, stop, setVolume, setServerRate, getOutputRate };
}