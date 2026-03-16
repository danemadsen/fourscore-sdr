# @fourscore/sdr

A browser-native TypeScript client for both KiwiSDR and OpenWebRX receivers.

The public API is intentionally small: use a single `UniversalSDR` class, choose the backend with `'kiwisdr' | 'openwebrx'`, and receive everything through callbacks.

## Installation

```bash
npm install @fourscore/sdr
# or
yarn add @fourscore/sdr
```

## Quick Start

```ts
import { UniversalSDR } from '@fourscore/sdr';

const sdr = new UniversalSDR('kiwisdr', {
  host: 'sdr.example.com',
  onOpen: () => console.log('connected'),
  onAudio: ({ samples }) => {
    console.log('pcm samples', samples.length);
  },
  onWaterfall: ({ bins }) => {
    console.log('waterfall bins', bins.length);
  },
  onSMeter: (rssi) => {
    console.log('signal', rssi);
  },
  onError: (error) => {
    console.error(error);
  },
});

sdr.connect({
  frequency: 7200,
  mode: 'lsb',
  zoom: 0,
  centerFreq: 15000,
});
```

## API

### `new UniversalSDR(type, options)`

```ts
const kiwi = new UniversalSDR('kiwisdr', {
  host: 'kiwi.example.com',
  port: 8073,
  onAudio: ({ samples }) => { /* ... */ },
});

const owrx = new UniversalSDR('openwebrx', {
  host: 'openwebrx.example.com',
  onConfig: (config) => { /* ... */ },
});
```

`options` supports:

- `host`: hostname or `host:port`
- `port`: optional explicit port
- `password`: KiwiSDR password
- `username`: optional client name
- `onOpen`
- `onClose`
- `onAudio`
- `onWaterfall`
- `onError`
- `onSMeter`
- `onConfig`

### `sdr.connect(options)`

Starts audio and waterfall handling for the selected backend.

```ts
sdr.connect({
  frequency: 10125,
  mode: 'usb',
  lowCut: 300,
  highCut: 2700,
  sampleRate: 12000,
  agc: true,
  zoom: 2,
  centerFreq: 10125,
});
```

Common options:

- `frequency`: tuned frequency in kHz
- `mode`: audio mode
- `lowCut` / `highCut`: passband edges in Hz
- `sampleRate`: requested output rate
- `zoom`: waterfall zoom level
- `centerFreq`: waterfall center in kHz

KiwiSDR-specific optional controls:

- `agc`
- `agcHang`
- `agcThresh`
- `agcSlope`
- `agcDecay`
- `manGain`
- `compression`
- `squelch`
- `squelchMax`
- `maxDb`
- `minDb`
- `speed`
- `waterfallCompression`

OpenWebRX-specific note:

- `squelch` may be passed as a dB value when using the `openwebrx` backend

### Methods

```ts
sdr.tune(7100, 'lsb');
sdr.setAgc(false, 60);      // KiwiSDR only
sdr.setWaterfallView(4, 7100);
sdr.selectProfile('rtlsdr|am'); // OpenWebRX only
sdr.close();
```

`getStatus()` is also available for KiwiSDR connections.

## Callback Payloads

### `onAudio`

```ts
interface AudioData {
  samples: Int16Array;
  rssi: number;
  sequence: number;
  flags: number;
  gps?: GPSTimestamp;
}
```

### `onWaterfall`

```ts
interface WaterfallData {
  bins: Uint8Array | Float32Array;
  sequence: number;
  xBin: number;
  zoom: number;
  flags: number;
}
```

### `onConfig`

```ts
interface SDRConfig {
  type: 'kiwisdr' | 'openwebrx';
  centerFreq: number;
  bandwidth: number;
  viewCenterFreq: number;
  viewBandwidth: number;
  zoom: number;
  waterfallMin: number;
  waterfallMax: number;
  fftSize: number;
  audioCompression?: string;
  fftCompression?: string;
  profileId?: string;
  profileChanged?: boolean;
  startFreq?: number;
  startMode?: AudioMode;
  profiles?: SDRProfile[];
  activeProfileId?: string;
}
```

All frequency values in `SDRConfig` are reported in kHz.

## Audio Modes

`AUDIO_MODES` and `MODE_CUTS` are exported for clients that want sensible defaults for tuning UI.

## Browser Compatibility

Requires browser support for `WebSocket`, `fetch`, `TextDecoder`, and `DataView`.

## License

MIT
