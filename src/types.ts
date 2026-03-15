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
  /** FFT bin magnitudes (0-255 each) */
  bins: Uint8Array;
  /** Packet sequence number */
  sequence: number;
  /** Starting FFT bin index on server */
  xBin: number;
  /** Current zoom level */
  zoom: number;
  /** Raw flags from W/F header */
  flags: number;
}

export interface OpenWebRXOptions {
  /** Hostname, host:port, or full base URL */
  host: string;
  /** Port number, defaults to 8070 */
  port?: number;
  /** Use secure WebSocket/HTTPS transport */
  secure?: boolean;
  /** Optional base path when OpenWebRX is not mounted at the site root */
  basePath?: string;
}

export interface OpenWebRXConfig {
  /** Receiver center frequency in Hz */
  centerFreq: number;
  /** Receiver bandwidth / sample rate in Hz */
  sampleRate: number;
  /** FFT size advertised by the server */
  fftSize: number;
  /** Audio compression mode reported by the server */
  audioCompression: string;
  /** FFT compression mode reported by the server */
  fftCompression: string;
  /** Initial modulation selected by the server, if present */
  startMod?: string;
  /** Initial offset from center frequency in Hz, if present */
  startOffsetFreq?: number;
  /** Initial squelch threshold in dB, if present */
  initialSquelchLevel?: number;
  /** Raw config payload from the server */
  raw: Record<string, unknown>;
}

export interface OpenWebRXReceiverDetails {
  receiverName?: string;
  receiverLocation?: string;
  receiverAsl?: number;
  locator?: string;
  photoTitle?: string;
  photoDesc?: string;
  raw: Record<string, unknown>;
}

export interface OpenWebRXMessage {
  type: string;
  [key: string]: unknown;
}

// SND flags
export const SND_FLAG_ADC_OVFL = 0x02;
export const SND_FLAG_STEREO = 0x08;
export const SND_FLAG_COMPRESSED = 0x10;
export const SND_FLAG_LITTLE_ENDIAN = 0x80;
