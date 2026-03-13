import { KiwiSDROptions, AudioStreamOptions, WaterfallStreamOptions } from './types';
import { AudioStream } from './streams/audio';
import { WaterfallStream } from './streams/waterfall';

const DEFAULT_PORT = 8073;

function parseHost(input: string): { host: string; port: number } {
  // Support "host:port" or just "host"
  const match = input.match(/^(.+):(\d+)$/);
  if (match) return { host: match[1], port: parseInt(match[2], 10) };
  return { host: input, port: DEFAULT_PORT };
}

export class KiwiSDR {
  private readonly host: string;
  private readonly port: number;
  private readonly password: string;
  private _tsPromise: Promise<number> | null = null;

  private _getTs(): Promise<number> {
    if (!this._tsPromise) {
      this._tsPromise = fetch(`http://${this.host}:${this.port}/VER`)
        .then(r => r.json() as Promise<{ ts: number }>)
        .then(ver => ver.ts)
        .catch(() => Math.floor(Date.now() / 1000));
    }
    return this._tsPromise;
  }

  /**
   * Create a KiwiSDR client.
   *
   * @param options - Either a host string ("kiwi.example.com" or "kiwi.example.com:8080")
   *                  or a full options object.
   *
   * @example
   * const kiwi = new KiwiSDR('sdr.example.com');
   * const kiwi = new KiwiSDR('sdr.example.com:8080');
   * const kiwi = new KiwiSDR({ host: 'sdr.example.com', port: 8073, password: 'secret' });
   */
  constructor(options: string | KiwiSDROptions) {
    if (typeof options === 'string') {
      const parsed = parseHost(options);
      this.host = parsed.host;
      this.port = parsed.port;
      this.password = '';
    } else {
      const parsed = parseHost(options.host);
      this.host = parsed.host;
      this.port = options.port ?? parsed.port;
      this.password = options.password ?? '';
    }
  }

  /**
   * Open a real-time audio/IQ stream from the receiver.
   *
   * Emits:
   *  - `'open'` — WebSocket connected and configured
   *  - `'audio'` (AudioData) — decoded PCM frame with S-meter and optional GPS
   *  - `'smeter'` (number) — signal strength in dBm (convenience duplicate of audio.rssi)
   *  - `'msg'` (Record<string,string>) — raw MSG parameters from the server
   *  - `'close'` (code, reason) — connection closed
   *  - `'error'` (Error) — WebSocket or protocol error
   *
   * @example
   * const audio = kiwi.openAudioStream({ frequency: 7200, mode: 'lsb' });
   * audio.on('audio', ({ samples, rssi }) => { ... });
   * audio.close();
   */
  openAudioStream(opts: AudioStreamOptions): AudioStream {
    const merged: AudioStreamOptions = {
      ...opts,
      password: opts.password ?? this.password,
    };
    return new AudioStream(this.host, this.port, merged, this._getTs());
  }

  /**
   * Open a real-time waterfall (FFT spectrum) stream from the receiver.
   *
   * Emits:
   *  - `'open'` — WebSocket connected and configured
   *  - `'waterfall'` (WaterfallData) — 1024-bin FFT magnitude frame
   *  - `'msg'` (Record<string,string>) — raw MSG parameters from the server
   *  - `'close'` (code, reason) — connection closed
   *  - `'error'` (Error) — WebSocket or protocol error
   *
   * @example
   * const wf = kiwi.openWaterfallStream({ zoom: 3, centerFreq: 14000 });
   * wf.on('waterfall', ({ bins }) => { ... });
   * wf.close();
   */
  openWaterfallStream(opts: WaterfallStreamOptions = {}): WaterfallStream {
    const merged: WaterfallStreamOptions = {
      ...opts,
      password: opts.password ?? this.password,
    };
    return new WaterfallStream(this.host, this.port, merged, this._getTs());
  }

  /**
   * Fetch the server status page.  Returns parsed key=value pairs from
   * the plain-text `/status` endpoint that KiwiSDR exposes.
   *
   * @example
   * const status = await kiwi.getStatus();
   * console.log(status.rx_chans, status.users);
   */
  async getStatus(): Promise<Record<string, string>> {
    const url = `http://${this.host}:${this.port}/status`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    const result: Record<string, string> = {};
    for (const line of raw.trim().split('\n')) {
      const eq = line.indexOf('=');
      if (eq !== -1) {
        result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
    return result;
  }
}
