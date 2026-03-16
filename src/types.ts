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

export type SDRType = 'kiwisdr' | 'openwebrx';

export interface SDRProfile {
  id: string;
  name: string;
}

export interface SDRConfig {
  /** Active SDR implementation */
  type: SDRType;
  /** Current tuned frequency in kHz */
  frequency: number;
  /** Current demodulation mode */
  mode: AudioMode;
  /** Current low passband cut in Hz */
  lowCut: number;
  /** Current high passband cut in Hz */
  highCut: number;
  /** Current AGC state when supported */
  agc?: boolean;
  /** SDR hardware center frequency in kHz */
  centerFreq: number;
  /** Full SDR bandwidth in kHz */
  bandwidth: number;
  /** Current waterfall view center frequency in kHz */
  viewCenterFreq: number;
  /** Current visible waterfall bandwidth in kHz */
  viewBandwidth: number;
  /** Waterfall zoom level */
  zoom: number;
  /** Current waterfall minimum level in dB */
  waterfallMin: number;
  /** Current waterfall maximum level in dB */
  waterfallMax: number;
  /** Current FFT size reported by the backend */
  fftSize: number;
  /** Provider-specific audio compression mode */
  audioCompression?: string;
  /** Provider-specific waterfall compression mode */
  fftCompression?: string;
  /** Provider-specific active profile id */
  profileId?: string;
  /** Whether the active profile changed in the last update */
  profileChanged?: boolean;
  /** Provider-reported initial tuned frequency in kHz */
  startFreq?: number;
  /** Provider-reported initial tuned mode */
  startMode?: AudioMode;
  /** Available profiles, if supported by the provider */
  profiles?: SDRProfile[];
  /** Currently active profile, if supported by the provider */
  activeProfileId?: string;
}

export interface UniversalSDRCallbacks {
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onAudio?: (data: AudioData) => void;
  onWaterfall?: (data: WaterfallData) => void;
  onError?: (error: Error) => void;
  onSMeter?: (rssi: number) => void;
  onConfig?: (config: SDRConfig) => void;
}

export interface UniversalSDROptions extends UniversalSDRCallbacks {
  /** Hostname or host:port string */
  host: string;
  /** Port number, defaults to 8073 */
  port?: number;
  /** User password for protected receivers (KiwiSDR only) */
  password?: string;
  /** Username for identification */
  username?: string;
}

export interface UniversalSDRConnectOptions {
  /** Tuned frequency in kHz */
  frequency: number;
  /** Demodulation mode, defaults to 'am' */
  mode?: AudioMode;
  /** Low passband cut in Hz */
  lowCut?: number;
  /** High passband cut in Hz */
  highCut?: number;
  /** Output sample rate in Hz, defaults to 12000 */
  sampleRate?: number;
  /** Enable AGC (KiwiSDR only), defaults to true */
  agc?: boolean;
  agcHang?: boolean;
  /** AGC threshold in dB (KiwiSDR only) */
  agcThresh?: number;
  agcSlope?: number;
  /** AGC decay in ms (KiwiSDR only) */
  agcDecay?: number;
  /** Manual gain in dB (KiwiSDR only) */
  manGain?: number;
  /** Enable IMA-ADPCM audio compression where supported */
  compression?: boolean;
  /** Enable/disable KiwiSDR squelch or set OpenWebRX squelch level in dBm */
  squelch?: boolean | number;
  /** KiwiSDR squelch threshold */
  squelchMax?: number;
  /** Waterfall zoom level */
  zoom?: number;
  /** Waterfall center frequency in kHz */
  centerFreq?: number;
  /** Waterfall max dB (KiwiSDR only) */
  maxDb?: number;
  /** Waterfall min dB (KiwiSDR only) */
  minDb?: number;
  /** Waterfall update speed 1-4 (KiwiSDR only) */
  speed?: number;
  /** Enable waterfall compression (KiwiSDR only) */
  waterfallCompression?: boolean;
  /** Username override for this connection */
  username?: string;
}

// ─── SND flags ────────────────────────────────────────────────────────────────

export const SND_FLAG_ADC_OVFL = 0x02;
export const SND_FLAG_STEREO = 0x08;
export const SND_FLAG_COMPRESSED = 0x10;
export const SND_FLAG_LITTLE_ENDIAN = 0x80;
