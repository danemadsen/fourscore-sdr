import { BaseStream } from './base';
import { ImaAdpcmDecoder } from '../utils/adpcm';
import {
  AudioStreamOptions,
  AudioData,
  GPSTimestamp,
  SND_FLAG_COMPRESSED,
  SND_FLAG_STEREO,
} from '../types';

const DEFAULT_SAMPLE_RATE = 44100;

export interface AudioStreamEvents {
  on(event: 'open', listener: () => void): this;
  on(event: 'close', listener: (code: number, reason: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'msg', listener: (params: Record<string, string>) => void): this;
  on(event: 'audio', listener: (data: AudioData) => void): this;
  on(event: 'smeter', listener: (rssi: number) => void): this;
}

export class AudioStream extends BaseStream implements AudioStreamEvents {
  private readonly opts: Required<AudioStreamOptions>;
  private readonly decoder = new ImaAdpcmDecoder();

  constructor(
    host: string,
    port: number,
    opts: AudioStreamOptions,
  ) {
    const password = opts.password ?? '';
    const username = opts.username ?? 'fourscore';
    super(host, port, 'SND', password, username);

    this.opts = {
      frequency:   opts.frequency,
      mode:        opts.mode        ?? 'am',
      lowCut:      opts.lowCut      ?? -2700,
      highCut:     opts.highCut     ?? 2700,
      agc:         opts.agc         ?? true,
      agcHang:     opts.agcHang     ?? false,
      agcThresh:   opts.agcThresh   ?? -100,
      agcSlope:    opts.agcSlope    ?? 6,
      agcDecay:    opts.agcDecay    ?? 500,
      manGain:     opts.manGain     ?? 49,
      compression: opts.compression ?? true,
      squelch:     opts.squelch     ?? false,
      squelchMax:  opts.squelchMax  ?? 0,
      sampleRate:  opts.sampleRate  ?? DEFAULT_SAMPLE_RATE,
      password,
      username,
    };
  }

  protected onOpen(): void {
    const o = this.opts;
    this.send(`SET mod=${o.mode} low_cut=${o.lowCut} high_cut=${o.highCut} freq=${o.frequency.toFixed(3)}`);
    this.send(`SET agc=${o.agc ? 1 : 0} hang=${o.agcHang ? 1 : 0} thresh=${o.agcThresh} slope=${o.agcSlope} decay=${o.agcDecay} manGain=${o.manGain}`);
    this.send(`SET compression=${o.compression ? 1 : 0}`);
    this.send(`SET squelch=${o.squelch ? 1 : 0} max=${o.squelchMax}`);
  }

  protected onMsg(params: Record<string, string>): void {
    // Server sends audio_rate once the SND task is fully initialised — respond with SET AR OK
    if (params['audio_rate'] !== undefined) {
      this.send(`SET AR OK in=${params['audio_rate']} out=${this.opts.sampleRate}`);
    }
    // Server sends initial ADPCM state so the decoder is in sync
    if (params['audio_adpcm_state'] !== undefined) {
      const [idx, prev] = params['audio_adpcm_state'].split(',').map(Number);
      this.decoder.preset(idx, prev);
    }
  }

  protected onBinary(tag: string, body: Uint8Array): void {
    if (tag !== 'SND') return;
    if (body.length < 7) return;

    const view     = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const flags    = view.getUint8(0);
    const sequence = view.getUint32(1, true);   // little-endian
    const smeter   = view.getUint16(5, false);  // big-endian
    const rssi     = 0.1 * smeter - 127;
    let audioData  = body.subarray(7);

    let gps: GPSTimestamp | undefined;
    if (flags & SND_FLAG_STEREO) {
      // GPS timestamp is prepended to audio data in IQ/stereo mode
      if (audioData.length >= 10) {
        const gpsView = new DataView(audioData.buffer, audioData.byteOffset, audioData.byteLength);
        gps = {
          lastGpsSolution: gpsView.getUint8(0),
          seconds:         gpsView.getUint32(2, true),  // little-endian
          nanoseconds:     gpsView.getUint32(6, true),  // little-endian
        };
        audioData = audioData.subarray(10);
      }
    }

    let samples: Int16Array;
    if (flags & SND_FLAG_COMPRESSED) {
      samples = this.decoder.decode(audioData);
    } else {
      // Raw 16-bit big-endian PCM
      const pcmView = new DataView(audioData.buffer, audioData.byteOffset, audioData.byteLength);
      samples = new Int16Array(audioData.length / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = pcmView.getInt16(i * 2, false);  // big-endian
      }
    }

    const data: AudioData = { samples, rssi, sequence, flags, gps };
    this.emit('smeter', rssi);
    this.emit('audio', data);
  }

  /** Retune to a new frequency without reopening the connection. */
  tune(frequency: number, mode?: string, lowCut?: number, highCut?: number): void {
    const m  = mode    ?? this.opts.mode;
    const lc = lowCut  ?? this.opts.lowCut;
    const hc = highCut ?? this.opts.highCut;
    this.send(`SET mod=${m} low_cut=${lc} high_cut=${hc} freq=${frequency.toFixed(3)}`);
  }

  /** Adjust AGC settings on the fly. */
  setAgc(enabled: boolean, manGain?: number): void {
    const gain = manGain ?? this.opts.manGain;
    this.send(`SET agc=${enabled ? 1 : 0} hang=0 thresh=${this.opts.agcThresh} slope=${this.opts.agcSlope} decay=${this.opts.agcDecay} manGain=${gain}`);
  }

  /** Enable or disable squelch. */
  setSquelch(enabled: boolean, max?: number): void {
    const m = max ?? this.opts.squelchMax;
    this.send(`SET squelch=${enabled ? 1 : 0} max=${m}`);
  }
}
