import { EventEmitter } from '../utils/events';
import { ImaAdpcmDecoder } from '../utils/adpcm';
import { AudioMode, AudioData, OpenWebRXStreamOptions, OpenWebRXWaterfallData } from '../types';
import { MODE_CUTS } from '../modes';

/** Number of ADPCM padding samples to discard from the start of each FFT frame */
const COMPRESS_FFT_PAD_N = 10;

export interface OpenWebRXStreamEvents {
  on(event: 'open',      listener: () => void): this;
  on(event: 'close',     listener: (code: number, reason: string) => void): this;
  on(event: 'error',     listener: (err: Error) => void): this;
  on(event: 'msg',       listener: (msg: Record<string, unknown>) => void): this;
  on(event: 'audio',     listener: (data: AudioData) => void): this;
  on(event: 'waterfall', listener: (data: OpenWebRXWaterfallData) => void): this;
  on(event: 'smeter',    listener: (rssi: number) => void): this;
}

interface ResolvedOptions {
  frequency: number;
  mode: AudioMode;
  lowCut: number;
  highCut: number;
  outputRate: number;
  squelch: number;
  username: string;
}

export class OpenWebRXStream extends EventEmitter implements OpenWebRXStreamEvents {
  private ws: WebSocket | null = null;
  private closed = false;
  private readonly audioDecoder = new ImaAdpcmDecoder();
  private readonly fftDecoder = new ImaAdpcmDecoder();
  private audioCompression = 'none';
  private fftCompression = 'none';
  private centerFreq = 0;
  private bandwidth = 0;
  private sequence = 0;
  private readonly magicKey: string;
  private readonly opts: ResolvedOptions;

  constructor(host: string, port: number, opts: OpenWebRXStreamOptions) {
    super();
    this.magicKey = Math.random().toString(36).substring(2, 11);
    const cuts = MODE_CUTS[opts.mode];
    this.opts = {
      frequency:  opts.frequency,
      mode:       opts.mode,
      lowCut:     opts.lowCut  ?? cuts.lowCut,
      highCut:    opts.highCut ?? cuts.highCut,
      outputRate: opts.outputRate ?? 48000,
      squelch:    opts.squelch ?? -150,
      username:   opts.username ?? 'fourscore',
    };

    const url = `ws://${host}:${port}/ws/`;
    console.log(`[fourscore-sdr] openwebrx connecting to ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      ws.send('SERVER DE CLIENT client=openwebrx.js type=receiver');
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        this._handleText(event.data);
      } else {
        this._handleBinary(event.data as ArrayBuffer);
      }
    });

    ws.addEventListener('error', () => {
      this.emit('error', new Error('WebSocket error'));
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      this.emit('close', event.code, event.reason);
    });
  }

  private _handleText(text: string): void {
    if (text.startsWith('CLIENT DE SERVER')) {
      // Server acknowledged handshake — send connection properties
      this._sendJson({
        type: 'connectionproperties',
        params: {
          output_rate:    this.opts.outputRate,
          hd_output_rate: this.opts.outputRate,
        },
      });
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg['type'] as string | undefined;
    const params = (msg['params'] ?? {}) as Record<string, unknown>;

    switch (type) {
      case 'config':
        this.audioCompression = (params['audio_compression'] as string) ?? 'none';
        this.fftCompression   = (params['fft_compression']   as string) ?? 'none';
        this.centerFreq       = (params['center_freq']       as number) ?? 0;
        this.bandwidth        = (params['samp_rate']         as number) ?? 0;
        // Server is ready — set frequency and start DSP
        this._sendJson({
          type:   'setfrequency',
          params: { frequency: Math.round(this.opts.frequency * 1000), key: this.magicKey },
        });
        this._sendDspControl();
        this.emit('open');
        break;

      case 'smeter':
        this.emit('smeter', (params['S'] as number) ?? -127);
        break;

      default:
        this.emit('msg', msg);
    }
  }

  private _handleBinary(buf: ArrayBuffer): void {
    const type = new Uint8Array(buf, 0, 1)[0];
    const data = buf.slice(1);
    if (type === 1) this._handleWaterfall(data);
    else if (type === 2) this._handleAudio(data);
  }

  private _handleAudio(data: ArrayBuffer): void {
    let samples: Int16Array;
    if (this.audioCompression === 'adpcm') {
      this.audioDecoder.reset();
      samples = this.audioDecoder.decode(new Uint8Array(data));
    } else {
      // Raw big-endian 16-bit PCM
      const view = new DataView(data);
      samples = new Int16Array(data.byteLength / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(i * 2, false);
      }
    }
    const audioData: AudioData = { samples, rssi: -127, sequence: this.sequence++, flags: 0 };
    this.emit('audio', audioData);
  }

  private _handleWaterfall(data: ArrayBuffer): void {
    let bins: Float32Array;
    if (this.fftCompression === 'adpcm') {
      this.fftDecoder.reset();
      const decoded = this.fftDecoder.decode(new Uint8Array(data));
      const trimmed = decoded.subarray(COMPRESS_FFT_PAD_N);
      bins = new Float32Array(trimmed.length);
      for (let i = 0; i < trimmed.length; i++) bins[i] = trimmed[i] / 100;
    } else {
      bins = new Float32Array(data);
    }
    this.emit('waterfall', { bins, centerFreq: this.centerFreq, bandwidth: this.bandwidth });
  }

  private _sendDspControl(): void {
    this._sendJson({
      type: 'dspcontrol',
      params: {
        low_cut:      this.opts.lowCut,
        high_cut:     this.opts.highCut,
        offset_freq:  0,
        mod:          this.opts.mode,
        squelch_level: this.opts.squelch,
      },
    });
  }

  private _sendJson(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Retune without reopening the connection. frequency in kHz. */
  tune(frequency: number, mode: AudioMode, lowCut?: number, highCut?: number): void {
    this.opts.frequency = frequency;
    this.opts.mode = mode;
    const cuts = MODE_CUTS[mode];
    this.opts.lowCut  = lowCut  ?? cuts.lowCut;
    this.opts.highCut = highCut ?? cuts.highCut;
    this._sendJson({
      type:   'setfrequency',
      params: { frequency: Math.round(frequency * 1000), key: this.magicKey },
    });
    this._sendDspControl();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws?.close();
  }
}
