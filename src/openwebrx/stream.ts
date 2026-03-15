import { ImaAdpcmDecoder } from '../adpcm';
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

function fromOpenWebRXMode(mode: string): AudioMode {
  const match = Object.entries(OWRX_MODE_MAP).find(([, mapped]) => mapped === mode);
  return (match ? match[0] : mode) as AudioMode;
}

export interface OpenWebRXConfig {
  centerFreq: number;  // Hz
  bandwidth:  number;  // Hz (samp_rate)
  audioCompression: string;
  fftCompression: string;
  waterfallMin: number;  // dB
  waterfallMax: number;  // dB
  fftSize: number;       // bins per waterfall frame
  profileId?: string;
  profileChanged: boolean;
  startFreq?: number;    // Hz
  startMode?: AudioMode;
}

export interface OpenWebRXProfile {
  id:   string;  // "sdr_id|profile_id"
  name: string;
}

export interface OpenWebRXStreamEvents {
  on(event: 'open',      listener: () => void): this;
  on(event: 'close',     listener: (code: number, reason: string) => void): this;
  on(event: 'error',     listener: (err: Error) => void): this;
  on(event: 'config',    listener: (cfg: OpenWebRXConfig) => void): this;
  on(event: 'profiles',  listener: (profiles: OpenWebRXProfile[], activeId: string) => void): this;
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

export class OpenWebRXStream implements OpenWebRXStreamEvents {
  private _listeners: Map<string, ((...args: any[]) => void)[]> = new Map();

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    list.push(listener);
    this._listeners.set(event, list);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    this._listeners.set(event, list.filter(l => l !== listener));
    return this;
  }

  private emit(event: string, ...args: any[]): void {
    const list = this._listeners.get(event) ?? [];
    for (const listener of list) listener(...args);
  }

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
  private fftSize = 1024;
  private sequence = 0;
  private dspStarted = false;
  private openEmitted = false;
  private allowCenterFreqChanges = true;
  private activeProfileId = '';
  private lastConfigProfileId = '';
  // Audio rate measurement — detect actual server output rate from frame data
  private audioRateStart = 0;
  private audioRateSamples = 0;
  private audioRateReported = false;
  private readonly opts: ResolvedOptions;

  constructor(host: string, port: number, opts: OpenWebRXStreamOptions) {
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
        if (typeof value['audio_compression'] === 'string') {
          this.audioCompression = value['audio_compression'] as string;
        }
        if (typeof value['fft_compression'] === 'string') {
          this.fftCompression = value['fft_compression'] as string;
        }
        if (typeof value['center_freq'] === 'number') {
          this.centerFreq = value['center_freq'] as number;
        }
        if (typeof value['samp_rate'] === 'number') {
          this.bandwidth = value['samp_rate'] as number;
        }
        if (typeof value['allow_center_freq_changes'] === 'boolean') {
          this.allowCenterFreqChanges = value['allow_center_freq_changes'] as boolean;
        }
        const wfLevels = value['waterfall_levels'] as { min?: number; max?: number } | undefined;
        if (typeof wfLevels?.min === 'number') {
          this.waterfallMin = wfLevels.min;
        }
        if (typeof wfLevels?.max === 'number') {
          this.waterfallMax = wfLevels.max;
        }
        if (typeof value['fft_size'] === 'number') {
          this.fftSize = value['fft_size'] as number;
        }
        const profileId = value['sdr_id'] && value['profile_id']
          ? `${value['sdr_id']}|${value['profile_id']}`
          : undefined;
        const profileChanged = profileId !== undefined && profileId !== this.lastConfigProfileId;
        if (profileId !== undefined) {
          this.activeProfileId = profileId;
          this.lastConfigProfileId = profileId;
        }

        const startOffsetHz = value['start_offset_freq'] as number | undefined;
        const startFreqHz   = value['start_freq']        as number | undefined;
        const startModeRaw  = value['start_mod']         as string | undefined;
        const startMode = startModeRaw !== undefined ? fromOpenWebRXMode(startModeRaw) : undefined;
        const shouldAdoptStartState = !this.openEmitted || profileChanged;

        if (shouldAdoptStartState) {
          if (startFreqHz !== undefined) {
            this.opts.frequency = startFreqHz / 1000;
          } else if (startOffsetHz !== undefined) {
            this.opts.frequency = (this.centerFreq + startOffsetHz) / 1000;
          }
          if (startMode !== undefined) {
            this.opts.mode = startMode;
            const cuts = MODE_CUTS[startMode];
            if (cuts) {
              this.opts.lowCut  = cuts.lowCut;
              this.opts.highCut = cuts.highCut;
            }
          }
        }

        console.log('[fourscore-sdr] openwebrx config:', { center_freq: this.centerFreq, samp_rate: this.bandwidth, fft_size: this.fftSize, audio_compression: this.audioCompression, fft_compression: this.fftCompression, waterfall_levels: { min: this.waterfallMin, max: this.waterfallMax } });
        this.emit('config', {
          centerFreq:       this.centerFreq,
          bandwidth:        this.bandwidth,
          audioCompression: this.audioCompression,
          fftCompression:   this.fftCompression,
          waterfallMin:     this.waterfallMin,
          waterfallMax:     this.waterfallMax,
          fftSize:          this.fftSize,
          profileId,
          profileChanged,
          startFreq: startFreqHz ?? (startOffsetHz !== undefined ? this.centerFreq + startOffsetHz : undefined),
          startMode,
        });
        // Only start DSP once we have a valid config with real samp_rate.
        // The server sends 2-3 rapid config messages during startup; the first
        // ones have samp_rate=0 and would restart the DSP pipeline with wrong params.
        if (this.bandwidth > 0) {
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

      case 'profiles': {
        const profiles = (msg['value'] as Array<{ id: string; name: string }>)
          .map(p => ({ id: p.id, name: p.name }));
        this.emit('profiles', profiles, this.activeProfileId);
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
      if (this.allowCenterFreqChanges) {
        // Cross-band: ask server to retune SDR hardware center.
        // Wait for the new config before sending updated dspcontrol so we don't
        // momentarily apply an impossible offset against the old center frequency.
        this._sendJson({ type: 'setfrequency', params: { frequency: freqHz } });
      } else {
        console.warn('[fourscore-sdr] openwebrx tune is outside the active profile band and center frequency changes are disabled');
      }
      return;
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

  /**
   * Switch to a different SDR profile (e.g. "rtlsdr|160m").
   * The server will retune the hardware and send a new config message.
   * Mirrors the reference client: selectprofile → connectionproperties → dspcontrol → start.
   */
  selectProfile(profileId: string): void {
    this.activeProfileId = profileId;
    this._sendJson({ type: 'selectprofile', params: { profile: profileId } });
    // The server expects connectionproperties to be re-sent after a profile change
    this._sendJson({
      type: 'connectionproperties',
      params: { output_rate: this.opts.outputRate, hd_output_rate: this.opts.outputRate },
    });
    // Reset audio rate measurement — new profile may have different hardware/rate
    this.audioRateStart    = 0;
    this.audioRateSamples  = 0;
    this.audioRateReported = false;
    // The server will respond with a new config, which triggers _sendDspControl(true)
    // automatically. No need to send dspcontrol here — the new center_freq isn't
    // known yet and would produce a wrong offset.
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws?.close();
  }
}
