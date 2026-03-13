export type AudioMode =
  | 'am' | 'amn' | 'amw'
  | 'sam' | 'sal' | 'sau' | 'sas'
  | 'qam'
  | 'lsb' | 'lsn'
  | 'usb' | 'usn'
  | 'cw' | 'cwn'
  | 'nbfm' | 'nnfm' | 'wfm'
  | 'iq'
  | 'drm';

export interface KiwiSDROptions {
  /** Hostname or host:port string */
  host: string;
  /** Port number, defaults to 8073 */
  port?: number;
  /** User password for protected receivers */
  password?: string;
  /** Time-limit password (ipl) */
  tlimitPassword?: string;
}

export interface AudioStreamOptions {
  /** Center frequency in kHz */
  frequency: number;
  /** Demodulation mode, defaults to 'am' */
  mode?: AudioMode;
  /** Low passband cut in Hz (negative for LSB), defaults to -2700 */
  lowCut?: number;
  /** High passband cut in Hz, defaults to 2700 */
  highCut?: number;
  /** Enable AGC, defaults to true */
  agc?: boolean;
  agcHang?: boolean;
  /** AGC threshold in dB, defaults to -100 */
  agcThresh?: number;
  agcSlope?: number;
  /** AGC decay in ms, defaults to 500 */
  agcDecay?: number;
  /** Manual gain in dB (0-120), used when agc=false */
  manGain?: number;
  /** Enable IMA-ADPCM compression, defaults to true */
  compression?: boolean;
  /** Enable squelch, defaults to false */
  squelch?: boolean;
  squelchMax?: number;
  /** Output sample rate for rate negotiation, defaults to 44100 */
  sampleRate?: number;
  /** Password override for this stream */
  password?: string;
  /** Username for identification */
  username?: string;
}

export interface WaterfallStreamOptions {
  /** Zoom level 0-14, defaults to 0 (full span) */
  zoom?: number;
  /** Center frequency in kHz */
  centerFreq?: number;
  /** Max dB for display range, defaults to 0 */
  maxDb?: number;
  /** Min dB for display range, defaults to -100 */
  minDb?: number;
  /** Waterfall update speed 1-4 (updates/sec), defaults to 4 */
  speed?: number;
  /** Enable IMA-ADPCM compression, defaults to false */
  compression?: boolean;
  /** Interpolation mode */
  interp?: number;
  /** Password override for this stream */
  password?: string;
  /** Username for identification */
  username?: string;
}

export interface GPSTimestamp {
  lastGpsSolution: number;
  seconds: number;
  nanoseconds: number;
}

export interface AudioData {
  /** Decoded 16-bit PCM samples */
  samples: Int16Array;
  /** Signal strength in dBm */
  rssi: number;
  /** Packet sequence number */
  sequence: number;
  /** Raw SND flags byte */
  flags: number;
  /** GPS timestamp, present in IQ/stereo mode when GPS is enabled */
  gps?: GPSTimestamp;
}

export interface WaterfallData {
  /** FFT bin magnitudes: Uint8Array (KiwiSDR: byte = dBm+255) or Float32Array (raw dB, e.g. OpenWebRX) */
  bins: Uint8Array | Float32Array;
  /** Packet sequence number */
  sequence: number;
  /** Starting FFT bin index on server */
  xBin: number;
  /** Current zoom level */
  zoom: number;
  /** Raw flags from W/F header */
  flags: number;
}

// ─── OpenWebRX ────────────────────────────────────────────────────────────────

export interface OpenWebRXOptions {
  /** Hostname */
  host: string;
  /** Port number, defaults to 8073 */
  port?: number;
}

export interface OpenWebRXStreamOptions {
  /** Tuned frequency in kHz */
  frequency: number;
  /** Demodulation mode */
  mode: AudioMode;
  /** Low passband cut in Hz, defaults to mode default */
  lowCut?: number;
  /** High passband cut in Hz, defaults to mode default */
  highCut?: number;
  /** Audio output rate in Hz, defaults to 48000 */
  outputRate?: number;
  /** Squelch level in dBm, defaults to -150 (off) */
  squelch?: number;
  /** Username for identification */
  username?: string;
}

export interface OpenWebRXWaterfallData {
  /** FFT bin power values in dB */
  bins: Float32Array;
  /** Center frequency of the SDR in Hz */
  centerFreq: number;
  /** Bandwidth (sample rate) of the SDR in Hz */
  bandwidth: number;
}

// ─── SND flags ────────────────────────────────────────────────────────────────

export const SND_FLAG_ADC_OVFL = 0x02;
export const SND_FLAG_STEREO = 0x08;
export const SND_FLAG_COMPRESSED = 0x10;
export const SND_FLAG_LITTLE_ENDIAN = 0x80;
