import { MODE_CUTS } from './modes';
import { KiwiSDR } from './kiwisdr/client';
import type { AudioStream, WaterfallStream } from './kiwisdr/stream';
import { OpenWebRX } from './openwebrx/client';
import type {
  OpenWebRXConfig as InternalOpenWebRXConfig,
  OpenWebRXProfile as InternalOpenWebRXProfile,
  OpenWebRXStream,
} from './openwebrx/stream';
import type {
  AudioData,
  AudioMode,
  OpenWebRXWaterfallData,
  SDRConfig,
  SDRProfile,
  SDRType,
  UniversalSDRCallbacks,
  UniversalSDRConnectOptions,
  UniversalSDROptions,
  WaterfallData,
} from './types';

const DEFAULT_PORT = 8073;
const DEFAULT_SAMPLE_RATE = 12000;
const DEFAULT_KIWI_BANDWIDTH_KHZ = 30000;
const DEFAULT_KIWI_CENTER_KHZ = DEFAULT_KIWI_BANDWIDTH_KHZ / 2;
const DEFAULT_KIWI_MIN_DB = -100;
const DEFAULT_KIWI_MAX_DB = 0;
const DEFAULT_KIWI_FFT_SIZE = 1024;

interface ResolvedConnectOptions {
  frequency: number;
  mode: AudioMode;
  lowCut: number;
  highCut: number;
  sampleRate: number;
  agc: boolean;
  agcHang: boolean;
  agcThresh: number;
  agcSlope: number;
  agcDecay: number;
  manGain: number;
  compression: boolean;
  squelch: boolean | number;
  squelchMax: number;
  zoom: number;
  centerFreq: number;
  maxDb: number;
  minDb: number;
  speed: number;
  waterfallCompression: boolean;
  username: string;
}

function parseHost(host: string, port?: number): { host: string; port: number } {
  const match = host.match(/^(.+):(\d+)$/);
  if (match) {
    return {
      host: match[1],
      port: port ?? parseInt(match[2], 10),
    };
  }
  return { host, port: port ?? DEFAULT_PORT };
}

function clampZoom(zoom: number): number {
  return Math.max(0, Math.min(14, Math.round(zoom)));
}

function getVisibleBandwidth(bandwidth: number, zoom: number): number {
  return bandwidth / Math.pow(2, zoom);
}

function getOpenWebRXSquelchLevel(value: boolean | number): number {
  if (typeof value === 'number') return value;
  return value ? -90 : -150;
}

export class UniversalSDR {
  private readonly type: SDRType;
  private readonly host: string;
  private readonly port: number;
  private readonly password: string;
  private readonly defaultUsername: string;
  private readonly callbacks: UniversalSDRCallbacks;

  private sessionId = 0;
  private openNotified = false;
  private closeNotified = false;
  private closing = false;

  private audioStream: AudioStream | null = null;
  private waterfallStream: WaterfallStream | null = null;
  private openWebRXStream: OpenWebRXStream | null = null;

  private kiwiAudioReady = false;
  private kiwiWaterfallReady = false;

  private connectOptions: ResolvedConnectOptions | null = null;
  private waterfallSequence = 0;

  private openWebRXProfiles: SDRProfile[] = [];
  private openWebRXActiveProfileId = '';
  private openWebRXCenterFreq = 0;
  private openWebRXBandwidth = 0;
  private openWebRXWaterfallMin = -150;
  private openWebRXWaterfallMax = 0;
  private openWebRXFftSize = DEFAULT_KIWI_FFT_SIZE;
  private openWebRXAudioCompression = 'none';
  private openWebRXFftCompression = 'none';
  private openWebRXProfileId: string | undefined;
  private openWebRXStartFreq: number | undefined;
  private openWebRXStartMode: AudioMode | undefined;

  constructor(type: SDRType, options: UniversalSDROptions) {
    const parsed = parseHost(options.host, options.port);
    this.type = type;
    this.host = parsed.host;
    this.port = parsed.port;
    this.password = options.password ?? '';
    this.defaultUsername = options.username ?? 'fourscore';
    this.callbacks = options;
  }

  connect(options: UniversalSDRConnectOptions): void {
    const token = this.sessionId + 1;
    this.sessionId = token;
    this.disposeCurrentSession();
    const mode = options.mode ?? 'am';
    const cuts = MODE_CUTS[mode];
    const zoom = clampZoom(options.zoom ?? 0);

    this.connectOptions = {
      frequency: options.frequency,
      mode,
      lowCut: options.lowCut ?? cuts.lowCut,
      highCut: options.highCut ?? cuts.highCut,
      sampleRate: options.sampleRate ?? DEFAULT_SAMPLE_RATE,
      agc: options.agc ?? true,
      agcHang: options.agcHang ?? false,
      agcThresh: options.agcThresh ?? -100,
      agcSlope: options.agcSlope ?? 6,
      agcDecay: options.agcDecay ?? 500,
      manGain: options.manGain ?? 49,
      compression: options.compression ?? true,
      squelch: options.squelch ?? false,
      squelchMax: options.squelchMax ?? 0,
      zoom,
      centerFreq: options.centerFreq ?? (zoom === 0 ? DEFAULT_KIWI_CENTER_KHZ : options.frequency),
      maxDb: options.maxDb ?? DEFAULT_KIWI_MAX_DB,
      minDb: options.minDb ?? DEFAULT_KIWI_MIN_DB,
      speed: options.speed ?? 4,
      waterfallCompression: options.waterfallCompression ?? false,
      username: options.username ?? this.defaultUsername,
    };

    this.openNotified = false;
    this.closeNotified = false;
    this.closing = false;
    this.kiwiAudioReady = false;
    this.kiwiWaterfallReady = false;
    this.waterfallSequence = 0;
    this.resetOpenWebRXState();

    if (this.type === 'kiwisdr') {
      this.connectKiwi(token);
    } else {
      this.connectOpenWebRX(token);
    }
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.audioStream?.close();
    this.waterfallStream?.close();
    this.openWebRXStream?.close();
  }

  tune(frequency: number, mode?: AudioMode, lowCut?: number, highCut?: number): void {
    if (!this.connectOptions) return;

    const nextMode = mode ?? this.connectOptions.mode;
    const cuts = MODE_CUTS[nextMode];
    const nextLowCut = lowCut ?? cuts.lowCut;
    const nextHighCut = highCut ?? cuts.highCut;

    this.connectOptions.frequency = frequency;
    this.connectOptions.mode = nextMode;
    this.connectOptions.lowCut = nextLowCut;
    this.connectOptions.highCut = nextHighCut;

    if (this.type === 'kiwisdr') {
      this.audioStream?.tune(frequency, nextMode, nextLowCut, nextHighCut);
      return;
    }

    this.openWebRXStream?.tune(frequency, nextMode, nextLowCut, nextHighCut);
  }

  setAgc(enabled: boolean, manGain?: number): void {
    if (!this.connectOptions || this.type !== 'kiwisdr') return;
    this.connectOptions.agc = enabled;
    if (manGain !== undefined) this.connectOptions.manGain = manGain;
    this.audioStream?.setAgc(enabled, manGain);
  }

  setWaterfallView(zoom: number, centerFreq?: number): void {
    if (!this.connectOptions) return;

    this.connectOptions.zoom = clampZoom(zoom);
    if (centerFreq !== undefined) {
      this.connectOptions.centerFreq = centerFreq;
    } else if (this.connectOptions.zoom === 0) {
      this.connectOptions.centerFreq = this.type === 'kiwisdr'
        ? DEFAULT_KIWI_CENTER_KHZ
        : this.openWebRXCenterFreq || this.connectOptions.centerFreq;
    }

    if (this.type === 'kiwisdr') {
      this.waterfallStream?.setView(this.connectOptions.zoom, this.connectOptions.centerFreq);
      this.emitKiwiConfig();
      return;
    }

    if (this.connectOptions.zoom > 0) {
      this.connectOptions.centerFreq = this.getClampedOpenWebRXCenter(this.connectOptions.centerFreq);
    }
    this.emitOpenWebRXConfig(false);
  }

  selectProfile(profileId: string): void {
    if (this.type !== 'openwebrx') return;
    this.openWebRXActiveProfileId = profileId;
    this.emitOpenWebRXConfig(false);
    this.openWebRXStream?.selectProfile(profileId);
  }

  async getStatus(): Promise<Record<string, string>> {
    if (this.type !== 'kiwisdr') {
      throw new Error('getStatus is only available for KiwiSDR connections');
    }
    const kiwi = new KiwiSDR({
      host: this.host,
      port: this.port,
      password: this.password,
    });
    return kiwi.getStatus();
  }

  private disposeCurrentSession(): void {
    const audio = this.audioStream;
    const waterfall = this.waterfallStream;
    const openWebRX = this.openWebRXStream;

    this.audioStream = null;
    this.waterfallStream = null;
    this.openWebRXStream = null;
    this.connectOptions = null;
    this.openNotified = false;
    this.closeNotified = false;
    this.closing = false;
    this.kiwiAudioReady = false;
    this.kiwiWaterfallReady = false;
    this.resetOpenWebRXState();

    audio?.close();
    waterfall?.close();
    openWebRX?.close();
  }

  private connectKiwi(token: number): void {
    if (!this.connectOptions) return;

    const kiwi = new KiwiSDR({
      host: this.host,
      port: this.port,
      password: this.password,
    });

    const audio = kiwi.openAudioStream({
      frequency: this.connectOptions.frequency,
      mode: this.connectOptions.mode,
      lowCut: this.connectOptions.lowCut,
      highCut: this.connectOptions.highCut,
      agc: this.connectOptions.agc,
      agcHang: this.connectOptions.agcHang,
      agcThresh: this.connectOptions.agcThresh,
      agcSlope: this.connectOptions.agcSlope,
      agcDecay: this.connectOptions.agcDecay,
      manGain: this.connectOptions.manGain,
      compression: this.connectOptions.compression,
      squelch: typeof this.connectOptions.squelch === 'number'
        ? this.connectOptions.squelch !== 0
        : this.connectOptions.squelch,
      squelchMax: typeof this.connectOptions.squelch === 'number'
        ? this.connectOptions.squelch
        : this.connectOptions.squelchMax,
      sampleRate: this.connectOptions.sampleRate,
      username: this.connectOptions.username,
    });

    const waterfall = kiwi.openWaterfallStream({
      zoom: this.connectOptions.zoom,
      centerFreq: this.connectOptions.centerFreq,
      maxDb: this.connectOptions.maxDb,
      minDb: this.connectOptions.minDb,
      speed: this.connectOptions.speed,
      compression: this.connectOptions.waterfallCompression,
      username: this.connectOptions.username,
    });

    this.audioStream = audio;
    this.waterfallStream = waterfall;

    audio.on('open', () => {
      if (!this.isActiveSession(token)) return;
      this.kiwiAudioReady = true;
      this.maybeEmitKiwiOpen();
    });
    audio.on('audio', (data: AudioData) => {
      if (!this.isActiveSession(token)) return;
      this.callbacks.onAudio?.(data);
    });
    audio.on('smeter', (rssi: number) => {
      if (!this.isActiveSession(token)) return;
      this.callbacks.onSMeter?.(rssi);
    });
    audio.on('error', (error: Error) => this.handleError(token, error));
    audio.on('close', (code: number, reason: string) => this.handleClose(token, code, reason));

    waterfall.on('open', () => {
      if (!this.isActiveSession(token)) return;
      this.kiwiWaterfallReady = true;
      this.maybeEmitKiwiOpen();
    });
    waterfall.on('waterfall', (data: WaterfallData) => {
      if (!this.isActiveSession(token)) return;
      this.callbacks.onWaterfall?.(data);
    });
    waterfall.on('error', (error: Error) => this.handleError(token, error));
    waterfall.on('close', (code: number, reason: string) => this.handleClose(token, code, reason));
  }

  private connectOpenWebRX(token: number): void {
    if (!this.connectOptions) return;

    const openWebRX = new OpenWebRX({
      host: this.host,
      port: this.port,
    });

    const stream = openWebRX.connect({
      frequency: this.connectOptions.frequency,
      mode: this.connectOptions.mode,
      lowCut: this.connectOptions.lowCut,
      highCut: this.connectOptions.highCut,
      outputRate: this.connectOptions.sampleRate,
      squelch: getOpenWebRXSquelchLevel(this.connectOptions.squelch),
      username: this.connectOptions.username,
    });

    this.openWebRXStream = stream;

    stream.on('open', () => {
      if (!this.isActiveSession(token) || this.openNotified) return;
      this.openNotified = true;
      this.callbacks.onOpen?.();
    });
    stream.on('audio', (data: AudioData) => {
      if (!this.isActiveSession(token)) return;
      this.callbacks.onAudio?.(data);
    });
    stream.on('smeter', (rssi: number) => {
      if (!this.isActiveSession(token)) return;
      this.callbacks.onSMeter?.(rssi);
    });
    stream.on('config', (config: InternalOpenWebRXConfig) => {
      if (!this.isActiveSession(token)) return;
      this.handleOpenWebRXConfig(config);
    });
    stream.on('profiles', (profiles: InternalOpenWebRXProfile[], activeId: string) => {
      if (!this.isActiveSession(token)) return;
      this.openWebRXProfiles = profiles.map(profile => ({
        id: profile.id,
        name: profile.name,
      }));
      this.openWebRXActiveProfileId = activeId;
      this.emitOpenWebRXConfig(false);
    });
    stream.on('waterfall', (data: OpenWebRXWaterfallData) => {
      if (!this.isActiveSession(token)) return;
      this.callbacks.onWaterfall?.(this.normalizeOpenWebRXWaterfall(data));
    });
    stream.on('error', (error: Error) => this.handleError(token, error));
    stream.on('close', (code: number, reason: string) => this.handleClose(token, code, reason));
  }

  private maybeEmitKiwiOpen(): void {
    if (!this.connectOptions || this.openNotified) return;
    if (!this.kiwiAudioReady || !this.kiwiWaterfallReady) return;

    this.openNotified = true;
    this.emitKiwiConfig();
    this.callbacks.onOpen?.();
  }

  private handleOpenWebRXConfig(config: InternalOpenWebRXConfig): void {
    if (!this.connectOptions) return;

    this.openWebRXCenterFreq = config.centerFreq / 1000;
    this.openWebRXBandwidth = config.bandwidth / 1000;
    this.openWebRXWaterfallMin = config.waterfallMin;
    this.openWebRXWaterfallMax = config.waterfallMax;
    this.openWebRXFftSize = config.fftSize;
    this.openWebRXAudioCompression = config.audioCompression;
    this.openWebRXFftCompression = config.fftCompression;
    this.openWebRXProfileId = config.profileId;
    this.openWebRXActiveProfileId = config.profileId ?? this.openWebRXActiveProfileId;
    this.openWebRXStartFreq = config.startFreq !== undefined ? config.startFreq / 1000 : undefined;
    this.openWebRXStartMode = config.startMode;

    if (this.connectOptions.zoom === 0) {
      this.connectOptions.centerFreq = this.openWebRXCenterFreq;
    } else {
      this.connectOptions.centerFreq = this.getClampedOpenWebRXCenter(this.connectOptions.centerFreq);
    }

    this.emitOpenWebRXConfig(config.profileChanged);
  }

  private emitKiwiConfig(): void {
    if (!this.connectOptions) return;

    const bandwidth = DEFAULT_KIWI_BANDWIDTH_KHZ;
    const viewBandwidth = getVisibleBandwidth(bandwidth, this.connectOptions.zoom);

    this.callbacks.onConfig?.({
      type: 'kiwisdr',
      centerFreq: this.connectOptions.centerFreq,
      bandwidth,
      viewCenterFreq: this.connectOptions.centerFreq,
      viewBandwidth,
      zoom: this.connectOptions.zoom,
      waterfallMin: this.connectOptions.minDb,
      waterfallMax: this.connectOptions.maxDb,
      fftSize: DEFAULT_KIWI_FFT_SIZE,
    });
  }

  private emitOpenWebRXConfig(profileChanged: boolean): void {
    if (!this.connectOptions) return;

    const centerFreq = this.openWebRXCenterFreq;
    const bandwidth = this.openWebRXBandwidth;
    const viewCenterFreq = this.connectOptions.zoom === 0
      ? centerFreq
      : this.getClampedOpenWebRXCenter(this.connectOptions.centerFreq);
    const viewBandwidth = bandwidth > 0
      ? getVisibleBandwidth(bandwidth, this.connectOptions.zoom)
      : 0;

    this.callbacks.onConfig?.({
      type: 'openwebrx',
      centerFreq,
      bandwidth,
      viewCenterFreq,
      viewBandwidth,
      zoom: this.connectOptions.zoom,
      waterfallMin: this.openWebRXWaterfallMin,
      waterfallMax: this.openWebRXWaterfallMax,
      fftSize: this.openWebRXFftSize,
      audioCompression: this.openWebRXAudioCompression,
      fftCompression: this.openWebRXFftCompression,
      profileId: this.openWebRXProfileId,
      profileChanged,
      startFreq: this.openWebRXStartFreq,
      startMode: this.openWebRXStartMode,
      profiles: this.openWebRXProfiles.length > 0 ? [...this.openWebRXProfiles] : undefined,
      activeProfileId: this.openWebRXActiveProfileId || undefined,
    });
  }

  private normalizeOpenWebRXWaterfall(data: OpenWebRXWaterfallData): WaterfallData {
    if (!this.connectOptions || this.connectOptions.zoom === 0 || this.openWebRXBandwidth <= 0) {
      return {
        bins: data.bins,
        sequence: this.waterfallSequence++,
        xBin: 0,
        zoom: this.connectOptions?.zoom ?? 0,
        flags: 0,
      };
    }

    const visibleBandwidth = getVisibleBandwidth(this.openWebRXBandwidth, this.connectOptions.zoom);
    const viewCenterFreq = this.getClampedOpenWebRXCenter(this.connectOptions.centerFreq);
    const sdrStart = this.openWebRXCenterFreq - this.openWebRXBandwidth / 2;
    const startFreq = viewCenterFreq - visibleBandwidth / 2;
    const endFreq = viewCenterFreq + visibleBandwidth / 2;
    const startBin = Math.max(
      0,
      Math.round((startFreq - sdrStart) / this.openWebRXBandwidth * data.bins.length),
    );
    const endBin = Math.max(
      startBin + 1,
      Math.min(
        data.bins.length,
        Math.round((endFreq - sdrStart) / this.openWebRXBandwidth * data.bins.length),
      ),
    );

    return {
      bins: data.bins.slice(startBin, endBin),
      sequence: this.waterfallSequence++,
      xBin: startBin,
      zoom: this.connectOptions.zoom,
      flags: 0,
    };
  }

  private getClampedOpenWebRXCenter(centerFreq: number): number {
    if (!this.connectOptions || this.openWebRXBandwidth <= 0 || this.connectOptions.zoom === 0) {
      return this.openWebRXCenterFreq || centerFreq;
    }

    const visibleBandwidth = getVisibleBandwidth(this.openWebRXBandwidth, this.connectOptions.zoom);
    const half = visibleBandwidth / 2;
    const minCenter = this.openWebRXCenterFreq - this.openWebRXBandwidth / 2 + half;
    const maxCenter = this.openWebRXCenterFreq + this.openWebRXBandwidth / 2 - half;
    return Math.max(minCenter, Math.min(maxCenter, centerFreq));
  }

  private handleError(token: number, error: Error): void {
    if (!this.isActiveSession(token)) return;
    this.callbacks.onError?.(error);
  }

  private handleClose(token: number, code: number, reason: string): void {
    if (!this.isActiveSession(token) || this.closeNotified) return;

    this.closeNotified = true;
    const audio = this.audioStream;
    const waterfall = this.waterfallStream;
    const openWebRX = this.openWebRXStream;

    this.audioStream = null;
    this.waterfallStream = null;
    this.openWebRXStream = null;
    this.kiwiAudioReady = false;
    this.kiwiWaterfallReady = false;
    this.closing = true;
    this.connectOptions = null;
    this.resetOpenWebRXState();

    audio?.close();
    waterfall?.close();
    openWebRX?.close();

    this.callbacks.onClose?.(code, reason);
  }

  private isActiveSession(token: number): boolean {
    return token === this.sessionId;
  }

  private resetOpenWebRXState(): void {
    this.openWebRXProfiles = [];
    this.openWebRXActiveProfileId = '';
    this.openWebRXCenterFreq = 0;
    this.openWebRXBandwidth = 0;
    this.openWebRXWaterfallMin = -150;
    this.openWebRXWaterfallMax = 0;
    this.openWebRXFftSize = DEFAULT_KIWI_FFT_SIZE;
    this.openWebRXAudioCompression = 'none';
    this.openWebRXFftCompression = 'none';
    this.openWebRXProfileId = undefined;
    this.openWebRXStartFreq = undefined;
    this.openWebRXStartMode = undefined;
  }
}
