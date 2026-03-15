import { getOpenWebRXAudioProcessorUrl } from './worklets';

const DEFAULT_OUTPUT_RATE = 12000;
const DEFAULT_MAX_QUEUE_SECONDS = 2;
const DEFAULT_VOLUME = 0.8;
const DEFAULT_WORKLET_PROCESSOR_NAME = 'openwebrx-audio-processor';
const DEFAULT_PREFERRED_SAMPLE_RATES = [48000, 44100, 96000] as const;

type AudioContextWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

export interface WebAudioPcmPlayerOptions {
  initialVolume?: number;
  maxQueueSeconds?: number;
  defaultOutputRate?: number;
  preferredSampleRates?: readonly number[];
  workletProcessorName?: string;
  workletUrl?: string | null;
}

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

function createPreferredAudioContext(preferredSampleRates: readonly number[]): AudioContext {
  if (typeof window === 'undefined') throw new Error('Web Audio API requires a browser environment');

  const audioWindow = window as AudioContextWindow;
  const AudioContextClass = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio API is not supported in this browser');

  let ctx = new AudioContextClass({ latencyHint: 'playback' });
  if (preferredSampleRates.includes(ctx.sampleRate)) return ctx;

  ctx.close().catch(() => {});
  for (const sampleRate of preferredSampleRates) {
    try {
      ctx = new AudioContextClass({ sampleRate, latencyHint: 'playback' });
      return ctx;
    } catch {
      // Try the next preferred sample rate.
    }
  }

  return new AudioContextClass({ latencyHint: 'playback' });
}

function findOutputRate(targetRate: number, defaultOutputRate: number): { outputRate: number; factor: number } {
  let factor = 1;
  while (true) {
    const outputRate = Math.floor(targetRate / factor);
    if (outputRate < 8000) break;
    if (outputRate <= 12000) return { outputRate, factor };
    factor++;
  }
  return { outputRate: defaultOutputRate, factor: Math.max(1, Math.round(targetRate / defaultOutputRate)) };
}

function getBufferSize(sampleRate: number): number {
  if (sampleRate < 44100 * 2) return 4096;
  if (sampleRate < 44100 * 4) return 8192;
  return 16384;
}

export class WebAudioPcmPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private script: ScriptProcessorNode | null = null;
  private readonly queue: Float32Array[] = [];
  private queueSize = 0;
  private outputRate: number;
  private maxQueueSamples: number;
  private interpolator: Interpolator | null = null;
  private passthrough = true;
  private volume: number;

  constructor(private readonly options: WebAudioPcmPlayerOptions = {}) {
    const defaultOutputRate = this.options.defaultOutputRate ?? DEFAULT_OUTPUT_RATE;
    const maxQueueSeconds = this.options.maxQueueSeconds ?? DEFAULT_MAX_QUEUE_SECONDS;

    this.outputRate = defaultOutputRate;
    this.maxQueueSamples = defaultOutputRate * maxQueueSeconds;
    this.volume = this.options.initialVolume ?? DEFAULT_VOLUME;
  }

  init(): void {
    if (this.ctx) return;

    const preferredSampleRates = this.options.preferredSampleRates ?? DEFAULT_PREFERRED_SAMPLE_RATES;
    const defaultOutputRate = this.options.defaultOutputRate ?? DEFAULT_OUTPUT_RATE;
    const maxQueueSeconds = this.options.maxQueueSeconds ?? DEFAULT_MAX_QUEUE_SECONDS;
    const workletProcessorName = this.options.workletProcessorName ?? DEFAULT_WORKLET_PROCESSOR_NAME;
    const workletUrl = this.options.workletUrl === undefined
      ? getOpenWebRXAudioProcessorUrl()
      : this.options.workletUrl;

    const ctx = createPreferredAudioContext(preferredSampleRates);
    const { outputRate, factor } = findOutputRate(ctx.sampleRate, defaultOutputRate);
    const gain = ctx.createGain();
    const bufferSize = getBufferSize(ctx.sampleRate);

    gain.gain.value = this.volume;
    gain.connect(ctx.destination);

    this.ctx = ctx;
    this.gain = gain;
    this.outputRate = outputRate;
    this.maxQueueSamples = ctx.sampleRate * maxQueueSeconds;
    this.passthrough = factor === 1;
    this.interpolator = factor > 1 ? new Interpolator(factor) : null;

    if (ctx.audioWorklet && workletUrl) {
      ctx.audioWorklet.addModule(workletUrl).then(() => {
        if (this.ctx !== ctx || this.worklet) return;

        const node = new AudioWorkletNode(ctx, workletProcessorName, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: {
            maxBufferSize: this.maxQueueSamples,
          },
        });
        node.connect(gain);
        this.worklet = node;
        this.flushQueueToWorklet();
      }).catch(() => {
        this.connectScriptProcessor(ctx, gain, bufferSize);
      });
    } else {
      this.connectScriptProcessor(ctx, gain, bufferSize);
    }

    ctx.resume().catch(() => {});
  }

  play(samples: Int16Array): void {
    if (!this.ctx) return;

    let floats: Float32Array;
    if (this.passthrough) {
      floats = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
    } else {
      floats = this.interpolator!.process(samples);
    }

    if (this.worklet) {
      this.worklet.port.postMessage(floats);
      return;
    }

    this.enqueue(floats);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.gain) this.gain.gain.value = volume;
  }

  stop(): void {
    this.worklet?.disconnect();
    this.script?.disconnect();
    this.ctx?.close().catch(() => {});

    this.ctx = null;
    this.gain = null;
    this.worklet = null;
    this.script = null;
    this.interpolator = null;
    this.passthrough = true;
    this.queue.length = 0;
    this.queueSize = 0;

    const defaultOutputRate = this.options.defaultOutputRate ?? DEFAULT_OUTPUT_RATE;
    const maxQueueSeconds = this.options.maxQueueSeconds ?? DEFAULT_MAX_QUEUE_SECONDS;
    this.outputRate = defaultOutputRate;
    this.maxQueueSamples = defaultOutputRate * maxQueueSeconds;
  }

  getOutputRate(): number {
    return this.outputRate;
  }

  private connectScriptProcessor(ctx: AudioContext, gain: GainNode, bufferSize: number): void {
    if (this.script || this.worklet || this.ctx !== ctx || this.gain !== gain) return;

    // ScriptProcessorNode fallback: pulls from the shared queue on the main thread.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const script = ctx.createScriptProcessor(bufferSize, 0, 1);
    script.onaudioprocess = (event: AudioProcessingEvent) => {
      const output = event.outputBuffer.getChannelData(0);
      let position = 0;

      while (position < bufferSize && this.queue.length > 0) {
        const chunk = this.queue[0];
        const needed = bufferSize - position;

        if (chunk.length <= needed) {
          output.set(chunk, position);
          position += chunk.length;
          this.queue.shift();
          this.queueSize -= chunk.length;
        } else {
          output.set(chunk.subarray(0, needed), position);
          this.queue[0] = chunk.subarray(needed);
          this.queueSize -= needed;
          position = bufferSize;
        }
      }

      if (position < bufferSize) output.fill(0, position);
    };
    script.connect(gain);
    this.script = script;
  }

  private enqueue(chunk: Float32Array): void {
    this.queue.push(chunk);
    this.queueSize += chunk.length;

    while (this.queueSize > this.maxQueueSamples && this.queue.length > 1) {
      const dropped = this.queue.shift()!;
      this.queueSize -= dropped.length;
    }
  }

  private flushQueueToWorklet(): void {
    if (!this.worklet) return;

    while (this.queue.length > 0) {
      this.worklet.port.postMessage(this.queue.shift()!);
    }
    this.queueSize = 0;
  }
}
