# @fourscore/sdr

A browser-native TypeScript client for [KiwiSDR](http://kiwisdr.com/) receivers. Connects directly from the browser over WebSocket — no Node.js server required.

## Features

- Real-time audio streaming with IMA-ADPCM decompression
- Real-time waterfall (FFT spectrum) streaming
- Tune, AGC, and squelch controls without reconnecting
- Zero runtime dependencies — uses native browser `WebSocket` and `fetch`

## Installation

```bash
npm install @fourscore/sdr
# or
yarn add @fourscore/sdr
```

## Quick Start

```ts
import { KiwiSDR } from '@fourscore/sdr';

const kiwi = new KiwiSDR('sdr.example.com');

// Audio stream
const audio = kiwi.openAudioStream({ frequency: 7200, mode: 'lsb' });

audio.on('open', () => console.log('connected'));
audio.on('audio', ({ samples, rssi }) => {
  // samples: Int16Array of PCM data
  // rssi: signal strength in dBm
});
audio.on('close', (code, reason) => console.log('closed', code, reason));
audio.on('error', (err) => console.error(err));
```

## API

### `new KiwiSDR(options)`

| Argument | Type | Description |
|---|---|---|
| `options` | `string \| KiwiSDROptions` | Host string (`"host"` or `"host:port"`) or options object |

```ts
// String shorthand
const kiwi = new KiwiSDR('sdr.example.com');
const kiwi = new KiwiSDR('sdr.example.com:8080');

// Options object
const kiwi = new KiwiSDR({
  host: 'sdr.example.com',
  port: 8073,       // default: 8073
  password: 'secret',
});
```

---

### `kiwi.openAudioStream(opts): AudioStream`

Opens a real-time audio stream from the receiver.

```ts
const audio = kiwi.openAudioStream({
  frequency: 7200,       // kHz (required)
  mode: 'lsb',           // default: 'am'
  lowCut: -2700,         // Hz, default: -2700
  highCut: 2700,         // Hz, default: 2700
  agc: true,             // default: true
  agcThresh: -100,       // dB, default: -100
  agcDecay: 500,         // ms, default: 500
  compression: true,     // IMA-ADPCM, default: true
  squelch: false,        // default: false
  sampleRate: 44100,     // output sample rate, default: 44100
});
```

**Events**

| Event | Payload | Description |
|---|---|---|
| `open` | — | WebSocket connected and configured |
| `audio` | `AudioData` | Decoded PCM frame |
| `smeter` | `number` | Signal strength in dBm |
| `msg` | `Record<string, string>` | Raw MSG parameters from server |
| `close` | `code, reason` | Connection closed |
| `error` | `Error` | WebSocket or protocol error |

**`AudioData`**

```ts
interface AudioData {
  samples:  Int16Array;       // decoded PCM samples
  rssi:     number;           // signal strength in dBm
  sequence: number;           // packet sequence number
  flags:    number;           // raw SND flags byte
  gps?:     GPSTimestamp;     // GPS timestamp (IQ/stereo mode only)
}
```

**Methods**

```ts
audio.tune(7100, 'usb');              // retune without reconnecting
audio.setAgc(false, 60);             // disable AGC, set manual gain to 60 dB
audio.setSquelch(true, -90);         // enable squelch at -90 dBm
audio.close();                       // close the connection
```

---

### `kiwi.openWaterfallStream(opts?): WaterfallStream`

Opens a real-time FFT spectrum (waterfall) stream.

```ts
const wf = kiwi.openWaterfallStream({
  zoom: 3,            // zoom level 0-14, default: 0 (full span)
  centerFreq: 14000,  // kHz, default: 14000
  maxDb: 0,           // display range max dB, default: 0
  minDb: -100,        // display range min dB, default: -100
  speed: 4,           // updates/sec 1-4, default: 4
  compression: false, // default: false
});
```

**Events**

| Event | Payload | Description |
|---|---|---|
| `open` | — | WebSocket connected and configured |
| `waterfall` | `WaterfallData` | FFT frame |
| `msg` | `Record<string, string>` | Raw MSG parameters from server |
| `close` | `code, reason` | Connection closed |
| `error` | `Error` | WebSocket or protocol error |

**`WaterfallData`**

```ts
interface WaterfallData {
  bins:     Uint8Array;  // 1024 FFT bin magnitudes (0-255)
  sequence: number;      // packet sequence number
  xBin:     number;      // starting FFT bin index on server
  zoom:     number;      // current zoom level
  flags:    number;      // raw flags from W/F header
}
```

**Methods**

```ts
wf.setView(4, 10000);      // zoom to level 4 centered on 10 MHz
wf.setDbRange(-10, -120);  // adjust dB display range
wf.setSpeed(2);            // slow to 2 updates/sec
wf.close();
```

---

### `kiwi.getStatus(): Promise<Record<string, string>>`

Fetches the receiver's `/status` endpoint and returns parsed key/value pairs.

```ts
const status = await kiwi.getStatus();
console.log(status.rx_chans);  // number of available channels
console.log(status.users);     // current user count
```

---

## Audio Modes

| Mode | Description |
|---|---|
| `am` | AM (standard bandwidth) |
| `amn` | AM narrow |
| `amw` | AM wide |
| `lsb` | Lower sideband |
| `usb` | Upper sideband |
| `cw` | CW (standard) |
| `cwn` | CW narrow |
| `nbfm` | Narrow-band FM |
| `iq` | Raw IQ (stereo) |
| `drm` | DRM digital radio |

---

## Playing Audio in the Browser

The `samples` in each `AudioData` frame are raw 16-bit PCM at 12 kHz input / your configured output sample rate. To play them using the Web Audio API:

```ts
const audioCtx = new AudioContext({ sampleRate: 44100 });

audio.on('audio', ({ samples }) => {
  const buffer = audioCtx.createBuffer(1, samples.length, 44100);
  const channel = buffer.getChannelData(0);

  for (let i = 0; i < samples.length; i++) {
    channel[i] = samples[i] / 32768;  // normalise to [-1, 1]
  }

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start();
});
```

## Browser Compatibility

Requires a browser with support for `WebSocket`, `fetch`, `TextDecoder`, and `DataView` — all modern browsers since 2017.

## License

MIT
