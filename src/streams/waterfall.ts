import { BaseStream } from './base';
import { ImaAdpcmDecoder } from '../utils/adpcm';
import { WaterfallStreamOptions, WaterfallData } from '../types';

/** Number of FFT bins per waterfall frame */
const WF_BINS = 1024;
/** Number of tail samples to discard after ADPCM decompression */
const WF_ADPCM_TAIL = 10;

export interface WaterfallStreamEvents {
  on(event: 'open', listener: () => void): this;
  on(event: 'close', listener: (code: number, reason: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'msg', listener: (params: Record<string, string>) => void): this;
  on(event: 'waterfall', listener: (data: WaterfallData) => void): this;
}

export class WaterfallStream extends BaseStream implements WaterfallStreamEvents {
  private readonly opts: Required<WaterfallStreamOptions>;
  private readonly decoder = new ImaAdpcmDecoder();

  constructor(
    host: string,
    port: number,
    opts: WaterfallStreamOptions,
  ) {
    const password = opts.password ?? '';
    const username = opts.username ?? 'open-sigint';
    super(host, port, 'W/F', password, username);

    this.opts = {
      zoom:        opts.zoom        ?? 0,
      centerFreq:  opts.centerFreq  ?? 14000,
      maxDb:       opts.maxDb       ?? 0,
      minDb:       opts.minDb       ?? -100,
      speed:       opts.speed       ?? 4,
      compression: opts.compression ?? false,
      interp:      opts.interp      ?? 0,
      password,
      username,
    };
  }

  protected onOpen(): void {
    const o = this.opts;
    this.send(`SET zoom=${o.zoom} cf=${o.centerFreq.toFixed(3)}`);
    this.send(`SET maxdb=${o.maxDb} mindb=${o.minDb}`);
    this.send(`SET wf_speed=${o.speed}`);
    this.send(`SET wf_comp=${o.compression ? 1 : 0}`);
    if (o.interp !== 0) this.send(`SET interp=${o.interp}`);
  }

  protected onMsg(_params: Record<string, string>): void {
    // No MSG handling specific to waterfall
  }

  protected onBinary(tag: string, body: Uint8Array): void {
    if (tag !== 'W/F') return;
    if (body.length < 12) return;

    const view     = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const xBin     = view.getUint32(0, true);  // little-endian
    const flagsRaw = view.getUint32(4, true);  // little-endian
    const sequence = view.getUint32(8, true);  // little-endian
    const raw      = body.subarray(12);

    const zoom  = flagsRaw & 0xff;
    const flags = (flagsRaw >> 8) & 0xff;

    let bins: Uint8Array;
    if (this.opts.compression) {
      this.decoder.reset();
      const decoded = this.decoder.decode(raw);
      // Trim decompression tail and clamp to uint8
      const trimmed = decoded.subarray(0, Math.max(0, decoded.length - WF_ADPCM_TAIL));
      bins = Uint8Array.from(trimmed, v => Math.max(0, Math.min(255, v)));
    } else {
      bins = new Uint8Array(raw.buffer, raw.byteOffset, Math.min(raw.length, WF_BINS));
    }

    const data: WaterfallData = { bins, sequence, xBin, zoom, flags };
    this.emit('waterfall', data);
  }

  /** Pan/zoom to a new center frequency and zoom level without reopening. */
  setView(zoom: number, centerFreq: number): void {
    this.send(`SET zoom=${zoom} cf=${centerFreq.toFixed(3)}`);
  }

  /** Adjust the display dB range. */
  setDbRange(maxDb: number, minDb: number): void {
    this.send(`SET maxdb=${maxDb} mindb=${minDb}`);
  }

  /** Set waterfall update speed (1-4 updates/sec). */
  setSpeed(speed: number): void {
    this.send(`SET wf_speed=${speed}`);
  }
}
