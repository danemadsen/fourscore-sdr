import { MODE_CUTS } from './modes';
import {
  AudioData,
  AudioMode,
  AudioStreamOptions,
  OpenWebRXConfig,
  OpenWebRXMessage,
  OpenWebRXOptions,
  OpenWebRXReceiverDetails,
  WaterfallData,
  WaterfallStreamOptions,
} from './types';
import { ImaAdpcmDecoder } from './utils/adpcm';

const DEFAULT_PORT = 8070;
const DEFAULT_OUTPUT_RATE = 12000;
const DEFAULT_HD_OUTPUT_RATE = 36000;
const DEFAULT_DISABLED_SQUELCH = -150;
const WATERFALL_BIN_COUNT = 1024;
const COMPRESSED_FFT_PAD = 10;

type OpenWebRXNativeMode =
  | 'am'
  | 'sam'
  | 'lsb'
  | 'usb'
  | 'cw'
  | 'nfm'
  | 'wfm'
  | 'drm';

const MODE_MAP: Partial<Record<AudioMode, OpenWebRXNativeMode>> = {
  am: 'am',
  amn: 'am',
  amw: 'am',
  sam: 'sam',
  sal: 'sam',
  sau: 'sam',
  sas: 'sam',
  lsb: 'lsb',
  lsn: 'lsb',
  usb: 'usb',
  usn: 'usb',
  cw: 'cw',
  cwn: 'cw',
  nbfm: 'nfm',
  nnfm: 'nfm',
  wfm: 'wfm',
  drm: 'drm',
};

interface ParsedEndpoint {
  host: string;
  port: number;
  secure: boolean;
  basePath: string;
}

interface DemodulatorState {
  frequency: number;
  mode: AudioMode;
  lowCut: number;
  highCut: number;
  squelchLevel: number;
}

class EventEmitter {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, list.filter(l => l !== listener));
    return this;
  }

  protected emit(event: string, ...args: any[]): void {
    const list = this.listeners.get(event) ?? [];
    for (const listener of list) listener(...args);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeBasePath(pathname?: string): string {
  if (!pathname || pathname === '/') return '';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function parseHost(input: string, defaultPort: number): { host: string; port: number } {
  const match = input.match(/^(.+):(\d+)$/);
  if (match) return { host: match[1], port: parseInt(match[2], 10) };
  return { host: input, port: defaultPort };
}

function parseEndpoint(options: string | OpenWebRXOptions): ParsedEndpoint {
  if (typeof options === 'string') {
    if (options.includes('://')) {
      const url = new URL(options);
      return {
        host: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : DEFAULT_PORT),
        secure: url.protocol === 'https:' || url.protocol === 'wss:',
        basePath: normalizeBasePath(url.pathname),
      };
    }

    const parsed = parseHost(options, DEFAULT_PORT);
    return {
      host: parsed.host,
      port: parsed.port,
      secure: false,
      basePath: '',
    };
  }

  if (options.host.includes('://')) {
    const url = new URL(options.host);
    return {
      host: url.hostname,
      port: options.port ?? (url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : DEFAULT_PORT)),
      secure: options.secure ?? (url.protocol === 'https:' || url.protocol === 'wss:'),
      basePath: normalizeBasePath(options.basePath ?? url.pathname),
    };
  }

  const parsed = parseHost(options.host, DEFAULT_PORT);
  return {
    host: parsed.host,
    port: options.port ?? parsed.port,
    secure: options.secure ?? false,
    basePath: normalizeBasePath(options.basePath),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toOpenWebRXConfig(raw: Record<string, unknown>): OpenWebRXConfig {
  return {
    centerFreq: toNumber(raw['center_freq']) ?? 0,
    sampleRate: toNumber(raw['samp_rate']) ?? 0,
    fftSize: toNumber(raw['fft_size']) ?? WATERFALL_BIN_COUNT,
    audioCompression: toStringValue(raw['audio_compression']) ?? 'none',
    fftCompression: toStringValue(raw['fft_compression']) ?? 'none',
    startMod: toStringValue(raw['start_mod']),
    startOffsetFreq: toNumber(raw['start_offset_freq']),
    initialSquelchLevel: toNumber(raw['initial_squelch_level']),
    raw,
  };
}

function toOpenWebRXReceiverDetails(raw: Record<string, unknown>): OpenWebRXReceiverDetails {
  return {
    receiverName: toStringValue(raw['receiver_name']),
    receiverLocation: toStringValue(raw['receiver_location']),
    receiverAsl: toNumber(raw['receiver_asl']),
    locator: toStringValue(raw['locator']),
    photoTitle: toStringValue(raw['photo_title']),
    photoDesc: toStringValue(raw['photo_desc']),
    raw,
  };
}

function normalizeModeFromServer(mode?: string): AudioMode {
  switch (mode) {
    case 'am':
      return 'am';
    case 'sam':
      return 'sam';
    case 'lsb':
    case 'lsbd':
      return 'lsb';
    case 'usb':
    case 'usbd':
      return 'usb';
    case 'cw':
      return 'cw';
    case 'nfm':
      return 'nbfm';
    case 'wfm':
      return 'wfm';
    case 'drm':
      return 'drm';
    default:
      return 'am';
  }
}

function mapMode(mode: AudioMode): OpenWebRXNativeMode {
  const mapped = MODE_MAP[mode];
  if (!mapped) {
    throw new Error(`OpenWebRX does not support "${mode}" mode in this client`);
  }
  return mapped;
}

function decodePcm16Le(data: Uint8Array): Int16Array {
  const sampleCount = Math.floor(data.byteLength / 2);
  const view = new DataView(data.buffer, data.byteOffset, sampleCount * 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getInt16(i * 2, true);
  }
  return samples;
}

function decodeFloat32Le(data: Uint8Array): Float32Array {
  const sampleCount = Math.floor(data.byteLength / 4);
  const view = new DataView(data.buffer, data.byteOffset, sampleCount * 4);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getFloat32(i * 4, true);
  }
  return samples;
}

function quantizeWaterfall(levels: Float32Array): Uint8Array {
  if (levels.length === 0) return new Uint8Array(WATERFALL_BIN_COUNT);

  const bins = new Uint8Array(WATERFALL_BIN_COUNT);
  for (let i = 0; i < WATERFALL_BIN_COUNT; i++) {
    const start = Math.floor((i * levels.length) / WATERFALL_BIN_COUNT);
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / WATERFALL_BIN_COUNT));

    let total = 0;
    let count = 0;
    for (let j = start; j < end && j < levels.length; j++) {
      total += levels[j];
      count++;
    }

    const dB = count > 0 ? total / count : levels[Math.min(start, levels.length - 1)];
    bins[i] = clamp(Math.round(dB + 255), 0, 255);
  }

  return bins;
}

function downsampleInt16(samples: Int16Array, factor: number): Int16Array {
  if (factor <= 1) return samples;

  const out = new Int16Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let total = 0;
    for (let j = 0; j < factor; j++) {
      total += samples[i * factor + j];
    }
    out[i] = total / factor;
  }
  return out;
}

class SyncImaAdpcmDecoder {
  private stepIndex = 0;
  private predictor = 0;
  private step = 0;
  private synchronized = 0;
  private readonly syncWord = 'SYNC';
  private syncCounter = 0;
  private phase = 0;
  private readonly syncBuffer = new Uint8Array(4);
  private syncBufferIndex = 0;

  decode(data: Uint8Array): Int16Array {
    const output = new Int16Array(data.length * 2);
    let outputIndex = 0;

    for (let index = 0; index < data.length; index++) {
      switch (this.phase) {
        case 0:
          if (data[index] !== this.syncWord.charCodeAt(this.synchronized)) {
            this.synchronized = 0;
            break;
          }

          this.synchronized++;
          if (this.synchronized === this.syncWord.length) {
            this.syncBufferIndex = 0;
            this.phase = 1;
          }
          break;

        case 1:
          this.syncBuffer[this.syncBufferIndex++] = data[index];
          if (this.syncBufferIndex === this.syncBuffer.length) {
            const view = new DataView(this.syncBuffer.buffer);
            this.stepIndex = clamp(view.getInt16(0, true), 0, 88);
            this.predictor = clamp(view.getInt16(2, true), -32768, 32767);
            this.step = STEP_SIZE_TABLE[this.stepIndex];
            this.syncCounter = 1000;
            this.phase = 2;
          }
          break;

        case 2:
          output[outputIndex++] = this.decodeNibble(data[index] & 0x0f);
          output[outputIndex++] = this.decodeNibble(data[index] >> 4);

          if (this.syncCounter-- === 0) {
            this.synchronized = 0;
            this.phase = 0;
          }
          break;
      }
    }

    return output.subarray(0, outputIndex);
  }

  private decodeNibble(nibble: number): number {
    this.stepIndex = clamp(this.stepIndex + INDEX_ADJUST_TABLE[nibble], 0, 88);

    let diff = this.step >> 3;
    if (nibble & 1) diff += this.step >> 2;
    if (nibble & 2) diff += this.step >> 1;
    if (nibble & 4) diff += this.step;
    if (nibble & 8) diff = -diff;

    this.predictor = clamp(this.predictor + diff, -32768, 32767);
    this.step = STEP_SIZE_TABLE[this.stepIndex];
    return this.predictor;
  }
}

const STEP_SIZE_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

const INDEX_ADJUST_TABLE = [
  -1, -1, -1, -1,
   2,  4,  6,  8,
  -1, -1, -1, -1,
   2,  4,  6,  8,
];

abstract class OpenWebRXStreamBase extends EventEmitter {
  protected isClosed = false;
  private isOpen = false;

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.onCloseRequested();
    this.emit('close', 1000, 'stream closed');
  }

  protected emitOpen(): void {
    if (this.isClosed || this.isOpen) return;
    this.isOpen = true;
    this.emit('open');
  }

  protected emitConfig(config: OpenWebRXConfig, isInitial: boolean): void {
    this.emit('config', config);
    if (isInitial) this.emitOpen();
  }

  protected emitDetails(details: OpenWebRXReceiverDetails): void {
    if (!this.isClosed) this.emit('details', details);
  }

  protected emitMessage(message: OpenWebRXMessage): void {
    if (!this.isClosed) this.emit('msg', message);
  }

  protected emitError(error: Error): void {
    if (!this.isClosed) this.emit('error', error);
  }

  protected emitSocketClose(code: number, reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('close', code, reason);
  }

  protected abstract onCloseRequested(): void;
}

export interface OpenWebRXAudioStreamEvents {
  on(event: 'open', listener: () => void): this;
  on(event: 'close', listener: (code: number, reason: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'msg', listener: (message: OpenWebRXMessage) => void): this;
  on(event: 'config', listener: (config: OpenWebRXConfig) => void): this;
  on(event: 'details', listener: (details: OpenWebRXReceiverDetails) => void): this;
  on(event: 'audio', listener: (data: AudioData) => void): this;
  on(event: 'smeter', listener: (level: number) => void): this;
}

export interface OpenWebRXWaterfallStreamEvents {
  on(event: 'open', listener: () => void): this;
  on(event: 'close', listener: (code: number, reason: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'msg', listener: (message: OpenWebRXMessage) => void): this;
  on(event: 'config', listener: (config: OpenWebRXConfig) => void): this;
  on(event: 'details', listener: (details: OpenWebRXReceiverDetails) => void): this;
  on(event: 'waterfall', listener: (data: WaterfallData) => void): this;
}

export class OpenWebRXAudioStream extends OpenWebRXStreamBase implements OpenWebRXAudioStreamEvents {
  private readonly opts: {
    frequency: number;
    mode: AudioMode;
    lowCut: number;
    highCut: number;
    agc: boolean;
    squelch: boolean;
    squelchLevel: number;
    sampleRate: number;
  };

  constructor(private readonly session: OpenWebRXSession, opts: AudioStreamOptions) {
    super();

    const mode = opts.mode ?? 'am';
    const cuts = MODE_CUTS[mode];

    this.opts = {
      frequency: opts.frequency,
      mode,
      lowCut: opts.lowCut ?? cuts.lowCut,
      highCut: opts.highCut ?? cuts.highCut,
      agc: opts.agc ?? true,
      squelch: opts.squelch ?? false,
      squelchLevel: opts.squelch ? (opts.squelchMax ?? -100) : DEFAULT_DISABLED_SQUELCH,
      sampleRate: opts.sampleRate ?? DEFAULT_OUTPUT_RATE,
    };

    this.session.attachAudio(this);
  }

  tune(frequency: number, mode?: AudioMode, lowCut?: number, highCut?: number): void {
    const nextMode = mode ?? this.opts.mode;
    mapMode(nextMode);

    const cuts = MODE_CUTS[nextMode];
    const modeChanged = nextMode !== this.opts.mode;

    this.opts.frequency = frequency;
    this.opts.mode = nextMode;
    this.opts.lowCut = lowCut ?? (modeChanged ? cuts.lowCut : this.opts.lowCut);
    this.opts.highCut = highCut ?? (modeChanged ? cuts.highCut : this.opts.highCut);

    this.session.updateDemodulator(modeChanged);
  }

  setAgc(enabled: boolean, _manGain?: number): void {
    this.opts.agc = enabled;
  }

  setSquelch(enabled: boolean, level?: number): void {
    this.opts.squelch = enabled;
    this.opts.squelchLevel = enabled ? (level ?? this.opts.squelchLevel ?? -100) : DEFAULT_DISABLED_SQUELCH;
    this.session.updateDemodulator(false);
  }

  getOutputRate(): number {
    return this.opts.sampleRate;
  }

  getHdOutputRate(): number {
    if (this.opts.sampleRate >= DEFAULT_HD_OUTPUT_RATE) return this.opts.sampleRate;
    return this.opts.sampleRate * Math.ceil(DEFAULT_HD_OUTPUT_RATE / this.opts.sampleRate);
  }

  getDemodulatorState(config: OpenWebRXConfig | null): DemodulatorState {
    if (!config) {
      return {
        frequency: this.opts.frequency,
        mode: this.opts.mode,
        lowCut: this.opts.lowCut,
        highCut: this.opts.highCut,
        squelchLevel: this.opts.squelch ? this.opts.squelchLevel : DEFAULT_DISABLED_SQUELCH,
      };
    }

    const spanStart = (config.centerFreq - config.sampleRate / 2) / 1000;
    const spanEnd = (config.centerFreq + config.sampleRate / 2) / 1000;

    return {
      frequency: clamp(this.opts.frequency, spanStart, spanEnd),
      mode: this.opts.mode,
      lowCut: this.opts.lowCut,
      highCut: this.opts.highCut,
      squelchLevel: this.opts.squelch ? this.opts.squelchLevel : DEFAULT_DISABLED_SQUELCH,
    };
  }

  handleConfig(config: OpenWebRXConfig, isInitial: boolean): void {
    this.emitConfig(config, isInitial);
  }

  handleDetails(details: OpenWebRXReceiverDetails): void {
    this.emitDetails(details);
  }

  handleMessage(message: OpenWebRXMessage): void {
    this.emitMessage(message);
  }

  handleError(error: Error): void {
    this.emitError(error);
  }

  handleSocketClose(code: number, reason: string): void {
    this.emitSocketClose(code, reason);
  }

  handleSmeter(level: number): void {
    if (!this.isClosed) this.emit('smeter', level);
  }

  handleAudio(data: AudioData): void {
    if (!this.isClosed) this.emit('audio', data);
  }

  protected onCloseRequested(): void {
    this.session.detachAudio(this);
  }
}

export class OpenWebRXWaterfallStream extends OpenWebRXStreamBase implements OpenWebRXWaterfallStreamEvents {
  private readonly opts: Required<Pick<WaterfallStreamOptions, 'zoom' | 'centerFreq' | 'maxDb' | 'minDb' | 'speed'>>;

  constructor(private readonly session: OpenWebRXSession, opts: WaterfallStreamOptions = {}) {
    super();

    this.opts = {
      zoom: opts.zoom ?? 0,
      centerFreq: opts.centerFreq ?? 0,
      maxDb: opts.maxDb ?? -20,
      minDb: opts.minDb ?? -120,
      speed: opts.speed ?? 4,
    };

    this.session.attachWaterfall(this);
  }

  setView(zoom: number, centerFreq: number): void {
    this.opts.zoom = zoom;
    this.opts.centerFreq = centerFreq;
  }

  setDbRange(maxDb: number, minDb: number): void {
    this.opts.maxDb = maxDb;
    this.opts.minDb = minDb;
  }

  setSpeed(speed: number): void {
    this.opts.speed = speed;
  }

  handleConfig(config: OpenWebRXConfig, isInitial: boolean): void {
    if (this.opts.centerFreq === 0) {
      this.opts.centerFreq = config.centerFreq / 1000;
    }
    this.emitConfig(config, isInitial);
  }

  handleDetails(details: OpenWebRXReceiverDetails): void {
    this.emitDetails(details);
  }

  handleMessage(message: OpenWebRXMessage): void {
    this.emitMessage(message);
  }

  handleError(error: Error): void {
    this.emitError(error);
  }

  handleSocketClose(code: number, reason: string): void {
    this.emitSocketClose(code, reason);
  }

  handleWaterfall(data: WaterfallData): void {
    if (!this.isClosed) {
      this.emit('waterfall', { ...data, zoom: this.opts.zoom });
    }
  }

  protected onCloseRequested(): void {
    this.session.detachWaterfall(this);
  }
}

class OpenWebRXSession {
  private ws: WebSocket | null = null;
  private audioStream: OpenWebRXAudioStream | null = null;
  private waterfallStream: OpenWebRXWaterfallStream | null = null;

  private config: OpenWebRXConfig | null = null;
  private details: OpenWebRXReceiverDetails | null = null;
  private audioCompression = 'none';
  private fftCompression = 'none';
  private lastSmeter = DEFAULT_DISABLED_SQUELCH;
  private audioSequence = 0;
  private waterfallSequence = 0;
  private demodulatorStarted = false;
  private lastNativeMode: OpenWebRXNativeMode | null = null;
  private closing = false;

  private readonly audioDecoder = new SyncImaAdpcmDecoder();
  private readonly fftDecoder = new ImaAdpcmDecoder();

  constructor(private readonly endpoint: ParsedEndpoint) {}

  attachAudio(stream: OpenWebRXAudioStream): void {
    this.audioStream = stream;
    this.ensureConnected();
    this.replayState(stream);
  }

  detachAudio(stream: OpenWebRXAudioStream): void {
    if (this.audioStream === stream) {
      this.audioStream = null;
    }
    this.maybeClose();
  }

  attachWaterfall(stream: OpenWebRXWaterfallStream): void {
    this.waterfallStream = stream;
    this.ensureConnected();
    this.replayState(stream);
  }

  detachWaterfall(stream: OpenWebRXWaterfallStream): void {
    if (this.waterfallStream === stream) {
      this.waterfallStream = null;
    }
    this.maybeClose();
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
    this.config = null;
    this.details = null;
    this.demodulatorStarted = false;
    this.lastNativeMode = null;
  }

  updateDemodulator(forceRestart: boolean): void {
    this.applyDemodulator(forceRestart);
  }

  private replayState(stream: OpenWebRXStreamBase): void {
    if (this.config) {
      queueMicrotask(() => {
        if (stream instanceof OpenWebRXAudioStream) {
          stream.handleConfig(this.config as OpenWebRXConfig, true);
        } else if (stream instanceof OpenWebRXWaterfallStream) {
          stream.handleConfig(this.config as OpenWebRXConfig, true);
        }
      });
    }

    if (this.details) {
      queueMicrotask(() => {
        if (stream instanceof OpenWebRXAudioStream) {
          stream.handleDetails(this.details as OpenWebRXReceiverDetails);
        } else if (stream instanceof OpenWebRXWaterfallStream) {
          stream.handleDetails(this.details as OpenWebRXReceiverDetails);
        }
      });
    }
  }

  private maybeClose(): void {
    if (this.audioStream || this.waterfallStream) return;
    this.close();
  }

  private ensureConnected(): void {
    if (this.ws) return;

    const scheme = this.endpoint.secure ? 'wss' : 'ws';
    const port = this.endpoint.port === 80 || this.endpoint.port === 443 ? '' : `:${this.endpoint.port}`;
    const url = `${scheme}://${this.endpoint.host}${port}${this.endpoint.basePath}/ws/`;

    const ws = new WebSocket(url);
    this.ws = ws;
    this.closing = false;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      this.sendRaw('SERVER DE CLIENT client=fourscore-sdr type=receiver');
      const outputRate = this.audioStream?.getOutputRate() ?? DEFAULT_OUTPUT_RATE;
      const hdOutputRate = this.audioStream?.getHdOutputRate() ?? DEFAULT_HD_OUTPUT_RATE;

      this.sendJson({
        type: 'connectionproperties',
        params: {
          output_rate: outputRate,
          hd_output_rate: hdOutputRate,
        },
      });
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        this.handleText(event.data);
        return;
      }

      const buffer = new Uint8Array(event.data as ArrayBuffer);
      this.handleBinary(buffer);
    });

    ws.addEventListener('error', () => {
      this.broadcastError(new Error('OpenWebRX WebSocket error'));
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      this.ws = null;
      this.config = null;
      this.demodulatorStarted = false;
      this.lastNativeMode = null;

      if (this.audioStream) this.audioStream.handleSocketClose(event.code, event.reason);
      if (this.waterfallStream) this.waterfallStream.handleSocketClose(event.code, event.reason);

      if (!this.closing && (this.audioStream || this.waterfallStream)) {
        this.broadcastError(new Error(`OpenWebRX closed unexpectedly (${event.code}${event.reason ? `: ${event.reason}` : ''})`));
      }
    });
  }

  private sendRaw(message: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    this.sendRaw(JSON.stringify(payload));
  }

  private handleText(text: string): void {
    if (text.startsWith('CLIENT DE SERVER')) {
      this.broadcastMessage({ type: 'server_hello', raw: text });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.broadcastMessage({ type: 'text', raw: text });
      return;
    }

    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
      this.broadcastMessage({ type: 'unknown', raw: parsed });
      return;
    }

    const message = parsed as OpenWebRXMessage;
    const type = message.type;

    switch (type) {
      case 'config': {
        const raw = isRecord(message['value']) ? message['value'] : {};
        this.config = toOpenWebRXConfig(raw);
        this.audioCompression = this.config.audioCompression;
        this.fftCompression = this.config.fftCompression;

        this.audioStream?.handleConfig(this.config, true);
        this.waterfallStream?.handleConfig(this.config, true);
        this.applyDemodulator(true);
        break;
      }

      case 'receiver_details': {
        const raw = isRecord(message['value']) ? message['value'] : {};
        this.details = toOpenWebRXReceiverDetails(raw);
        this.audioStream?.handleDetails(this.details);
        this.waterfallStream?.handleDetails(this.details);
        break;
      }

      case 'smeter': {
        const value = toNumber(message['value']);
        if (value !== undefined && value > 0) {
          this.lastSmeter = 10 * Math.log10(value);
          this.audioStream?.handleSmeter(this.lastSmeter);
        }
        break;
      }

      case 'backoff': {
        const reason = toStringValue(message['reason']) ?? 'Too many clients';
        this.broadcastError(new Error(`OpenWebRX server busy: ${reason}`));
        break;
      }

      case 'sdr_error':
      case 'demodulator_error': {
        const err = toStringValue(message['value']);
        if (err) this.broadcastError(new Error(err));
        break;
      }
    }

    this.broadcastMessage(message);
  }

  private handleBinary(buffer: Uint8Array): void {
    if (buffer.byteLength === 0) return;

    const frameType = buffer[0];
    const payload = buffer.subarray(1);

    switch (frameType) {
      case 1:
        this.handleWaterfallFrame(payload);
        break;
      case 2:
        this.handleAudioFrame(payload, false);
        break;
      case 4:
        this.handleAudioFrame(payload, true);
        break;
    }
  }

  private handleWaterfallFrame(payload: Uint8Array): void {
    if (!this.waterfallStream) return;

    let levels: Float32Array;
    if (this.fftCompression === 'adpcm') {
      this.fftDecoder.reset();
      const decoded = this.fftDecoder.decode(payload);
      const trimmed = decoded.subarray(Math.min(COMPRESSED_FFT_PAD, decoded.length));
      levels = new Float32Array(trimmed.length);
      for (let i = 0; i < trimmed.length; i++) {
        levels[i] = trimmed[i] / 100;
      }
    } else {
      levels = decodeFloat32Le(payload);
    }

    this.waterfallSequence++;
    this.waterfallStream.handleWaterfall({
      bins: quantizeWaterfall(levels),
      sequence: this.waterfallSequence,
      xBin: 0,
      zoom: 0,
      flags: 0,
    });
  }

  private handleAudioFrame(payload: Uint8Array, isHd: boolean): void {
    if (!this.audioStream) return;

    let samples = this.audioCompression === 'adpcm'
      ? this.audioDecoder.decode(payload)
      : decodePcm16Le(payload);

    if (isHd) {
      const outputRate = this.audioStream.getOutputRate();
      const hdRate = this.audioStream.getHdOutputRate();
      const factor = hdRate / outputRate;
      if (Number.isInteger(factor) && factor > 1) {
        samples = downsampleInt16(samples, factor);
      }
    }

    this.audioSequence++;
    this.audioStream.handleAudio({
      samples,
      rssi: this.lastSmeter,
      sequence: this.audioSequence,
      flags: isHd ? 0x04 : 0x02,
    });
  }

  private applyDemodulator(forceRestart: boolean): void {
    if (!this.config || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const state = this.audioStream
      ? this.audioStream.getDemodulatorState(this.config)
      : this.getDefaultDemodulatorState();

    const nativeMode = mapMode(state.mode);
    const offsetFreq = Math.round(state.frequency * 1000 - this.config.centerFreq);

    this.sendJson({
      type: 'dspcontrol',
      params: {
        low_cut: Math.round(state.lowCut),
        high_cut: Math.round(state.highCut),
        offset_freq: offsetFreq,
        mod: nativeMode,
        squelch_level: state.squelchLevel,
      },
    });

    if (forceRestart || !this.demodulatorStarted || this.lastNativeMode !== nativeMode) {
      this.sendJson({
        type: 'dspcontrol',
        action: 'start',
      });
      this.demodulatorStarted = true;
      this.lastNativeMode = nativeMode;
    }
  }

  private getDefaultDemodulatorState(): DemodulatorState {
    const mode = normalizeModeFromServer(this.config?.startMod);
    const cuts = MODE_CUTS[mode];
    const centerFreq = this.config?.centerFreq ?? 0;
    const offset = this.config?.startOffsetFreq ?? 0;

    return {
      frequency: (centerFreq + offset) / 1000,
      mode,
      lowCut: cuts.lowCut,
      highCut: cuts.highCut,
      squelchLevel: this.config?.initialSquelchLevel ?? DEFAULT_DISABLED_SQUELCH,
    };
  }

  private broadcastMessage(message: OpenWebRXMessage): void {
    this.audioStream?.handleMessage(message);
    this.waterfallStream?.handleMessage(message);
  }

  private broadcastError(error: Error): void {
    this.audioStream?.handleError(error);
    this.waterfallStream?.handleError(error);
  }
}

export class OpenWebRX {
  private readonly session: OpenWebRXSession;

  constructor(options: string | OpenWebRXOptions) {
    this.session = new OpenWebRXSession(parseEndpoint(options));
  }

  openAudioStream(opts: AudioStreamOptions): OpenWebRXAudioStream {
    return new OpenWebRXAudioStream(this.session, opts);
  }

  openWaterfallStream(opts: WaterfallStreamOptions = {}): OpenWebRXWaterfallStream {
    return new OpenWebRXWaterfallStream(this.session, opts);
  }

  close(): void {
    this.session.close();
  }
}
