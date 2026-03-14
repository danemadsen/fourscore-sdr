import { EventEmitter } from '../utils/events';
import { ImaAdpcmDecoder } from '../utils/adpcm';
import { AudioMode, AudioData, OpenWebRXStreamOptions, OpenWebRXWaterfallData } from '../types';
import { MODE_CUTS } from '../modes';

/** Number of ADPCM padding samples to discard from the start of each FFT frame */
const COMPRESS_FFT_PAD_N = 10;

/**
 * Maps our internal AudioMode names to the modulation strings OpenWebRX understands.
 * OpenWebRX accepts: am, sam, lsb, usb, cw, nfm, wfm (and digital modes).
 * Variants like amn/amw/lsn/nbfm have no direct equivalent — map to the closest.
 */
const OWRX_MODE_MAP: Record<string, string> = {
  am:   'am',   amn:  'am',   amw:  'am',
  sam:  'sam',  sal:  'sam',  sau:  'sam',  sas: 'sam',
  qam:  'am',
  lsb:  'lsb',  lsn:  'lsb',
  usb:  'usb',  usn:  'usb',
  cw:   'cw',   cwn:  'cw',
  nbfm: 'nfm',  nnfm: 'nfm',
  wfm:  'wfm',
  iq:   'iq',
  drm:  'drm',
};

export interface OpenWebRXConfig {
  centerFreq: number;  // Hz
  bandwidth:  number;  // Hz (samp_rate)
  audioCompression: string;
  fftCompression: string;
  waterfallMin: number;  // dB
  waterfallMax: number;  // dB
  fftSize: number;       // bins per waterfall frame
}

export interface OpenWebRXStreamEvents {
  on(event: 'open',      listener: () => void): this;
  on(event: 'close',     listener: (code: number, reason: string) => void): this;
  on(event: 'error',     listener: (err: Error) => void): this;
  on(event: 'config',    listener: (cfg: OpenWebRXConfig) => void): this;
  on(event: 'msg',       listener: (msg: Record<string, unknown>) => void): this;
  on(event: 'audio',     listener: (data: AudioData) => void): this;
  on(event: 'waterfall', listener: (data: OpenWebRXWaterfallData) => void): this;
  on(event: 'smeter',    listener: (rssi: number) => void): this;
  on(event: 'audiorate', listener: (rate: number) => void): this;
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
  private waterfallMin = -150;
  private waterfallMax = 0;
  private sequence = 0;
  private dspStarted = false;
  private openEmitted = false;
  // Audio rate measurement — detect actual server output rate from frame data
  private audioRateStart = 0;
  private audioRateSamples = 0;
  private audioRateReported = false;
  private readonly opts: ResolvedOptions;

  constructor(host: string, port: number, opts: OpenWebRXStreamOptions) {
    super();
    const cuts = MODE_CUTS[opts.mode];
    this.opts = {
      frequency:  opts.frequency,
      mode:       opts.mode,
      lowCut:     opts.lowCut  ?? cuts.lowCut,
      highCut:    opts.highCut ?? cuts.highCut,
      outputRate: opts.outputRate ?? 12000,
      squelch:    opts.squelch ?? -150,
      username:   opts.username ?? 'fourscore',
    };

    const url = `ws://${host}:${port}/ws/`;
    console.log(`[fourscore-sdr] openwebrx connecting to ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      // Send both messages immediately on connect (same as the reference client)
      ws.send('SERVER DE CLIENT client=openwebrx.js type=receiver');
      this._sendJson({
        type: 'connectionproperties',
        params: { output_rate: this.opts.outputRate, hd_output_rate: this.opts.outputRate },
      });
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
    if (text.startsWith('CLIENT DE SERVER')) return;  // acknowledged, nothing to do

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg['type'] as string | undefined;
    // Config fields are under msg['value'], not msg['params']
    const value = (msg['value'] ?? {}) as Record<string, unknown>;

    switch (type) {
      case 'config': {
        this.audioCompression = (value['audio_compression'] as string) ?? 'none';
        this.fftCompression   = (value['fft_compression']   as string) ?? 'none';
        this.centerFreq       = (value['center_freq']       as number) ?? 0;
        this.bandwidth        = (value['samp_rate']         as number) ?? 0;
        const wfLevels = value['waterfall_levels'] as { min?: number; max?: number } | undefined;
        this.waterfallMin = wfLevels?.min ?? -150;
        this.waterfallMax = wfLevels?.max ?? 0;
        const fftSize = (value['fft_size'] as number) ?? 1024;
        console.log('[fourscore-sdr] openwebrx config:', { center_freq: this.centerFreq, samp_rate: this.bandwidth, fft_size: fftSize, audio_compression: this.audioCompression, fft_compression: this.fftCompression, waterfall_levels: { min: this.waterfallMin, max: this.waterfallMax } });
        this.emit('config', {
          centerFreq:       this.centerFreq,
          bandwidth:        this.bandwidth,
          audioCompression: this.audioCompression,
          fftCompression:   this.fftCompression,
          waterfallMin:     this.waterfallMin,
          waterfallMax:     this.waterfallMax,
          fftSize,
        });
        // Only start DSP once we have a valid config with real samp_rate.
        // The server sends 2-3 rapid config messages during startup; the first
        // ones have samp_rate=0 and would restart the DSP pipeline with wrong params.
        if (this.bandwidth > 0) {
          // On first valid config, adopt start_offset_freq / start_mod if provided.
          // This puts us at a frequency the server knows is within its tunable range,
          // avoiding an out-of-band offset if the user's initial frequency doesn't match.
          if (!this.openEmitted) {
            const startOffsetHz = value['start_offset_freq'] as number | undefined;
            const startMod      = value['start_mod']         as string | undefined;
            if (startOffsetHz !== undefined) {
              this.opts.frequency = (this.centerFreq + startOffsetHz) / 1000;
            }
            if (startMod !== undefined) {
              // Reverse-map OpenWebRX mod name back to our AudioMode
              const rev = Object.entries(OWRX_MODE_MAP).find(([, v]) => v === startMod);
              const newMode = rev ? rev[0] as import('../types').AudioMode : startMod as import('../types').AudioMode;
              this.opts.mode = newMode;
              // Also update filter cuts to match the new mode — without this we'd
              // send NFM mode with LSB filter cuts, producing garbled/no audio.
              const cuts = MODE_CUTS[newMode];
              if (cuts) {
                this.opts.lowCut  = cuts.lowCut;
                this.opts.highCut = cuts.highCut;
              }
            }
          }
          // Always force action:start on config — mirrors the reference client which
          // stops and restarts the demodulator on every config (including the one
          // the server sends after a setfrequency command recenters the SDR hardware).
          this._sendDspControl(true);
          if (!this.openEmitted) {
            this.openEmitted = true;
            this.emit('open');
          }
        }
        break;
      }

      case 'smeter': {
        // Server sends raw linear power; convert to dB as the reference client does
        const raw = (msg['value'] as number) ?? 0;
        this.emit('smeter', raw > 0 ? 10 * Math.log10(raw) : -127);
        break;
      }

      default:
        this.emit('msg', msg);
    }
  }

  private _audioFrameCount = 0;

  private _handleBinary(buf: ArrayBuffer): void {
    const type = new Uint8Array(buf, 0, 1)[0];
    const data = buf.slice(1);
    if (type === 1) this._handleWaterfall(data);
    else if (type === 2) this._handleAudio(data, type);
    else if (type === 4) this._handleAudio(data, type);  // HD audio (WFM)
    else console.log('[fourscore-sdr] unknown binary type:', type, 'len:', data.byteLength);
  }

  private _handleAudio(data: ArrayBuffer, type: number): void {
    let samples: Int16Array;
    if (this.audioCompression === 'adpcm') {
      // Do NOT reset — decodeWithSync maintains state across frames
      samples = this.audioDecoder.decodeWithSync(new Uint8Array(data));
    } else {
      // Raw little-endian 16-bit PCM — truncate to even byte count
      samples = new Int16Array(data, 0, Math.floor(data.byteLength / 2));
    }
    // Log first few frames so we can verify audio is actually arriving and changing
    this._audioFrameCount++;
    if (this._audioFrameCount <= 3 || this._audioFrameCount % 200 === 0) {
      const s = samples;
      let min = 0, max = 0, rms = 0;
      for (let i = 0; i < Math.min(s.length, 512); i++) {
        if (s[i] < min) min = s[i];
        if (s[i] > max) max = s[i];
        rms += s[i] * s[i];
      }
      rms = Math.sqrt(rms / Math.min(s.length, 512));
      console.log(`[fourscore-sdr] audio frame #${this._audioFrameCount} type=${type} compression=${this.audioCompression} bytes=${data.byteLength} samples=${s.length} min=${min} max=${max} rms=${rms.toFixed(0)}`);
    }
    // Measure the actual server output rate from incoming sample counts.
    // 2000000 Hz SDR can't produce exactly 12000 Hz (not an integer divisor),
    // so the server rounds to the nearest achievable rate (e.g. 10000 or 8000 Hz).
    // We measure for 2 seconds then emit 'audiorate' so the player can resample.
    if (!this.audioRateReported && samples.length > 0) {
      const now = performance.now();
      if (!this.audioRateStart) {
        this.audioRateStart = now;
      } else {
        this.audioRateSamples += samples.length;
        const elapsed = (now - this.audioRateStart) / 1000;
        if (elapsed >= 2.0) {
          const measuredRate = Math.round(this.audioRateSamples / elapsed);
          this.audioRateReported = true;
          this.emit('audiorate', measuredRate);
        }
      }
    }

    const audioData: AudioData = { samples, rssi: -127, sequence: this.sequence++, flags: 0 };
    this.emit('audio', audioData);
  }

  private _handleWaterfall(data: ArrayBuffer): void {
    let bins: Float32Array;
    // Auto-detect format from frame size rather than trusting config state,
    // because multiple config messages may arrive and update state while
    // earlier-encoded frames are still in flight.
    if (data.byteLength % 4 !== 0) {
      // ADPCM: byteLen = (COMPRESS_FFT_PAD_N + fftSize) / 2 → fftSize = byteLen*2 - COMPRESS_FFT_PAD_N
      this.fftDecoder.reset();
      const decoded = this.fftDecoder.decode(new Uint8Array(data));
      const trimmed = decoded.subarray(COMPRESS_FFT_PAD_N);
      bins = new Float32Array(trimmed.length);
      for (let i = 0; i < trimmed.length; i++) bins[i] = trimmed[i] / 100;
    } else {
      bins = new Float32Array(data, 0, data.byteLength / 4);
    }
    this.emit('waterfall', { bins, centerFreq: this.centerFreq, bandwidth: this.bandwidth });
  }

  private _sendDspControl(forceStart = false): void {
    const offsetHz = this.centerFreq > 0
      ? Math.round(this.opts.frequency * 1000) - this.centerFreq
      : 0;
    const mod = OWRX_MODE_MAP[this.opts.mode] ?? this.opts.mode;
    const params = {
      low_cut:          this.opts.lowCut,
      high_cut:         this.opts.highCut,
      offset_freq:      offsetHz,
      mod,
      squelch_level:    this.opts.squelch,
      secondary_mod:    false,
      dmr_filter:       3,
      audio_service_id: 0,
    };
    console.log('[fourscore-sdr] → dspcontrol', JSON.stringify({ type: 'dspcontrol', params }));
    this._sendJson({ type: 'dspcontrol', params });
    if (!this.dspStarted || forceStart) {
      this.dspStarted = true;
      console.log('[fourscore-sdr] dspcontrol action:start');
      this._sendJson({ type: 'dspcontrol', action: 'start' });
    }
  }

  private _sendJson(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Retune without reopening the connection. frequency in kHz. */
  tune(frequency: number, mode: AudioMode, lowCut?: number, highCut?: number): void {
    const modeChanged = mode !== this.opts.mode;
    this.opts.frequency = frequency;
    this.opts.mode = mode;
    const cuts = MODE_CUTS[mode];
    this.opts.lowCut  = lowCut  ?? cuts.lowCut;
    this.opts.highCut = highCut ?? cuts.highCut;

    const freqHz  = Math.round(frequency * 1000);
    const offsetHz = this.centerFreq > 0 ? freqHz - this.centerFreq : 0;
    const withinBand = this.bandwidth > 0 && Math.abs(offsetHz) <= this.bandwidth / 2;

    if (!withinBand && this.centerFreq > 0) {
      // Cross-band: ask server to retune SDR hardware center.
      // Server will reply with a new config → config handler sends corrected dspcontrol.
      this._sendJson({ type: 'setfrequency', params: { frequency: freqHz } });
    }

    // Always send action:start — the server at some installations ignores params-only
    // dspcontrol updates and requires a restart to apply the new offset/mode.
    this._sendDspControl(true);

    if (modeChanged) {
      this.audioRateStart    = 0;
      this.audioRateSamples  = 0;
      this.audioRateReported = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws?.close();
  }
}
