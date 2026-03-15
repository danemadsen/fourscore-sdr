import { useState, useRef, useCallback, useEffect } from 'react';
import { KiwiSDR, OpenWebRX, MODE_CUTS, AUDIO_MODES } from '@fourscore/sdr';
import type {
  AudioMode,
  AudioStream,
  OpenWebRXAudioStream,
  OpenWebRXConfig,
  OpenWebRXWaterfallStream,
  WaterfallStream,
} from '@fourscore/sdr';
import { Waterfall, type WaterfallHandle } from './components/Waterfall';
import { SMeter } from './components/SMeter';
import { useAudio } from './hooks/useAudio';

type BackendKind = 'kiwi' | 'openwebrx';
type AnyAudioStream = AudioStream | OpenWebRXAudioStream;
type AnyWaterfallStream = WaterfallStream | OpenWebRXWaterfallStream;

interface BackendConfig {
  kind: BackendKind;
  name: string;
  url: URL;
}

const OPENWEBRX_AUDIO_MODES = AUDIO_MODES.filter((mode): mode is AudioMode => mode !== 'iq' && mode !== 'qam');

function parseEnvUrl(value: string | undefined): URL | null {
  if (!value) return null;

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const BACKENDS: BackendConfig[] = [];

const kiwiUrl = parseEnvUrl(import.meta.env.VITE_KIWI_SDR_URL as string | undefined);
if (kiwiUrl) {
  BACKENDS.push({ kind: 'kiwi', name: 'KiwiSDR', url: kiwiUrl });
}

const openWebRXUrl = parseEnvUrl(import.meta.env.VITE_OPENWEBRX_SDR_URL as string | undefined);
if (openWebRXUrl) {
  BACKENDS.push({ kind: 'openwebrx', name: 'OpenWebRX', url: openWebRXUrl });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundFrequency(freq: number): number {
  return Math.round(freq * 10) / 10;
}

export default function App() {
  const [backend, setBackend] = useState<BackendKind>(BACKENDS[0]?.kind ?? 'kiwi');
  const [connected, setConnected] = useState(false);
  const [frequency, setFrequency] = useState(7200);
  const [freqInput, setFreqInput] = useState('7200');
  const [mode, setMode] = useState<AudioMode>('lsb');
  const [lowCut, setLowCut] = useState(MODE_CUTS.lsb.lowCut);
  const [highCut, setHighCut] = useState(MODE_CUTS.lsb.highCut);
  const [zoom, setZoom] = useState(0);
  const [receiverBandwidth, setReceiverBandwidth] = useState(30000);
  const [receiverCenterFreq, setReceiverCenterFreq] = useState(15000);
  const [viewCenterFreq, setViewCenterFreq] = useState(15000);
  const [agc, setAgc] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [rssi, setRssi] = useState(-127);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('DISCONNECTED');

  const audioStreamRef = useRef<AnyAudioStream | null>(null);
  const wfStreamRef = useRef<AnyWaterfallStream | null>(null);
  const wfRef = useRef<WaterfallHandle>(null);

  const audio = useAudio();

  const activeBackend = BACKENDS.find(candidate => candidate.kind === backend) ?? BACKENDS[0] ?? null;
  const availableModes = backend === 'openwebrx' ? OPENWEBRX_AUDIO_MODES : AUDIO_MODES;
  const maxFrequency = receiverCenterFreq + receiverBandwidth / 2;
  const minFrequency = receiverCenterFreq - receiverBandwidth / 2;
  const agcSupported = backend === 'kiwi';
  const meterUnit = backend === 'openwebrx' ? 'dB' : 'dBm';

  const clampFrequencyToReceiver = useCallback((nextFrequency: number) => {
    return roundFrequency(clamp(nextFrequency, minFrequency, maxFrequency));
  }, [minFrequency, maxFrequency]);

  const clampViewCenter = useCallback((nextCenterFreq: number, nextZoom: number) => {
    if (nextZoom <= 0) return receiverCenterFreq;

    const visibleBandwidth = receiverBandwidth / Math.pow(2, nextZoom);
    const minCenter = receiverCenterFreq - receiverBandwidth / 2 + visibleBandwidth / 2;
    const maxCenter = receiverCenterFreq + receiverBandwidth / 2 - visibleBandwidth / 2;
    return clamp(nextCenterFreq, minCenter, maxCenter);
  }, [receiverBandwidth, receiverCenterFreq]);

  const disconnect = useCallback(() => {
    audioStreamRef.current?.close();
    wfStreamRef.current?.close();
    audioStreamRef.current = null;
    wfStreamRef.current = null;
    audio.stop();
    setConnected(false);
    setStatus('DISCONNECTED');
    setRssi(-127);
  }, [audio]);

  useEffect(() => {
    if (!availableModes.includes(mode)) {
      const nextMode = availableModes[0] ?? 'am';
      const cuts = MODE_CUTS[nextMode];
      setMode(nextMode);
      setLowCut(cuts.lowCut);
      setHighCut(cuts.highCut);
    }
  }, [availableModes, mode]);

  useEffect(() => {
    if (backend !== 'kiwi') return;

    setReceiverBandwidth(30000);
    setReceiverCenterFreq(15000);
    if (zoom === 0) {
      setViewCenterFreq(15000);
    }
  }, [backend, zoom]);

  useEffect(() => {
    audio.setVolume(volume);
  }, [volume, audio]);

  const applyReceiverConfig = useCallback((config: OpenWebRXConfig) => {
    if (config.sampleRate <= 0 || config.centerFreq <= 0) return;

    const nextBandwidth = config.sampleRate / 1000;
    const nextReceiverCenter = config.centerFreq / 1000;
    const serverDefaultFrequency = config.startOffsetFreq !== undefined
      ? (config.centerFreq + config.startOffsetFreq) / 1000
      : nextReceiverCenter;
    const nextClampViewCenter = (nextCenterFreq: number, nextZoom: number) => {
      if (nextZoom <= 0) return nextReceiverCenter;

      const visibleBandwidth = nextBandwidth / Math.pow(2, nextZoom);
      const minCenter = nextReceiverCenter - nextBandwidth / 2 + visibleBandwidth / 2;
      const maxCenter = nextReceiverCenter + nextBandwidth / 2 - visibleBandwidth / 2;
      return clamp(nextCenterFreq, minCenter, maxCenter);
    };

    setReceiverBandwidth(nextBandwidth);
    setReceiverCenterFreq(nextReceiverCenter);
    const nextViewCenter = nextClampViewCenter(viewCenterFreq || nextReceiverCenter, zoom);
    setViewCenterFreq(nextViewCenter);
    wfStreamRef.current?.setView(zoom, nextViewCenter);

    const isCurrentFrequencyVisible =
      frequency >= nextReceiverCenter - nextBandwidth / 2 &&
      frequency <= nextReceiverCenter + nextBandwidth / 2;

    const nextFrequency = clamp(
      isCurrentFrequencyVisible ? frequency : serverDefaultFrequency,
      nextReceiverCenter - nextBandwidth / 2,
      nextReceiverCenter + nextBandwidth / 2,
    );

    const roundedFrequency = roundFrequency(nextFrequency);
    setFrequency(roundedFrequency);
    setFreqInput(roundedFrequency.toFixed(1));
    audioStreamRef.current?.tune(roundedFrequency, mode, lowCut, highCut);
  }, [frequency, highCut, lowCut, mode, viewCenterFreq, zoom]);

  const tuneReceiver = useCallback((rawFrequency: number, recenterView: boolean) => {
    const nextFrequency = clampFrequencyToReceiver(rawFrequency);

    setFrequency(nextFrequency);
    setFreqInput(nextFrequency.toFixed(1));
    audioStreamRef.current?.tune(nextFrequency, mode, lowCut, highCut);

    if (recenterView) {
      const nextViewCenter = clampViewCenter(nextFrequency, zoom);
      setViewCenterFreq(nextViewCenter);
      wfStreamRef.current?.setView(zoom, nextViewCenter);
    }
  }, [clampFrequencyToReceiver, clampViewCenter, highCut, lowCut, mode, zoom]);

  const connect = useCallback(() => {
    if (connected) {
      disconnect();
      return;
    }

    if (!activeBackend) {
      setError('No SDR backends are configured in example/.env');
      setStatus('ERROR');
      return;
    }

    setError(null);
    setStatus('CONNECTING...');
    audio.init();

    if (activeBackend.kind === 'kiwi') {
      const kiwi = new KiwiSDR({
        host: activeBackend.url.hostname,
        port: parseInt(activeBackend.url.port || '8073', 10),
      });

      const astream = kiwi.openAudioStream({
        frequency,
        mode,
        lowCut,
        highCut,
        agc,
        sampleRate: 12000,
      });
      audioStreamRef.current = astream;

      astream.on('open', () => {
        setConnected(true);
        setStatus('CONNECTED');
      });

      astream.on('audio', ({ samples, rssi: level }) => {
        console.log('[kiwi audio]', samples.length, level);
        audio.play(samples);
        setRssi(level);
      });

      astream.on('smeter', (level) => {
        console.log('[kiwi smeter]', level);
      });

      astream.on('msg', (message) => {
        console.log('[kiwi audio msg]', message);
      });

      astream.on('error', (err) => {
        setError(err.message);
        setStatus('ERROR');
        setConnected(false);
      });

      astream.on('close', (code: number, reason: string) => {
        console.log('[kiwi audio close]', code, reason);
        setConnected(false);
        setStatus(`DISCONNECTED (${code}${reason ? ': ' + reason : ''})`);
      });

      const wfstream = kiwi.openWaterfallStream({
        zoom,
        centerFreq: viewCenterFreq,
        speed: 4,
        maxDb: -20,
        minDb: -120,
      });
      wfStreamRef.current = wfstream;

      wfstream.on('waterfall', (data) => {
        wfRef.current?.addRow(data);
      });

      wfstream.on('msg', (message) => {
        console.log('[kiwi waterfall msg]', message);
      });

      wfstream.on('error', (err) => {
        console.log('[kiwi waterfall error]', err.message);
        setError(err.message);
      });

      wfstream.on('close', (code: number, reason: string) => {
        console.log('[kiwi waterfall close]', code, reason);
      });

      return;
    }

    const openWebRX = new OpenWebRX({
      host: activeBackend.url.hostname,
      port: parseInt(activeBackend.url.port || '8070', 10),
      secure: activeBackend.url.protocol === 'https:',
    });

    const astream = openWebRX.openAudioStream({
      frequency,
      mode,
      lowCut,
      highCut,
      sampleRate: 12000,
    });
    audioStreamRef.current = astream;

    astream.on('config', applyReceiverConfig);
    astream.on('open', () => {
      setConnected(true);
      setStatus('CONNECTED');
    });
    astream.on('audio', ({ samples, rssi: level }) => {
      console.log('[openwebrx audio]', samples.length, level);
      audio.play(samples);
      setRssi(level);
    });
    astream.on('smeter', (level) => {
      console.log('[openwebrx smeter]', level);
      setRssi(level);
    });
    astream.on('msg', (message) => {
      console.log('[openwebrx audio msg]', message);
    });
    astream.on('error', (err) => {
      setError(err.message);
      setStatus('ERROR');
      setConnected(false);
    });
    astream.on('close', (code: number, reason: string) => {
      console.log('[openwebrx audio close]', code, reason);
      setConnected(false);
      setStatus(`DISCONNECTED (${code}${reason ? ': ' + reason : ''})`);
    });

    const wfstream = openWebRX.openWaterfallStream({
      zoom,
      centerFreq: viewCenterFreq,
      speed: 4,
      maxDb: -20,
      minDb: -120,
    });
    wfStreamRef.current = wfstream;

    wfstream.on('config', applyReceiverConfig);
    wfstream.on('waterfall', (data) => {
      wfRef.current?.addRow(data);
    });
    wfstream.on('msg', (message) => {
      console.log('[openwebrx waterfall msg]', message);
    });
    wfstream.on('error', (err) => {
      console.log('[openwebrx waterfall error]', err.message);
      setError(err.message);
    });
    wfstream.on('close', (code: number, reason: string) => {
      console.log('[openwebrx waterfall close]', code, reason);
    });
  }, [
    activeBackend,
    agc,
    applyReceiverConfig,
    audio,
    connected,
    disconnect,
    frequency,
    highCut,
    lowCut,
    mode,
    viewCenterFreq,
    zoom,
  ]);

  const handleFreqKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;

    const nextFrequency = parseFloat(freqInput);
    if (!Number.isNaN(nextFrequency) && nextFrequency > 0) {
      tuneReceiver(nextFrequency, zoom > 0);
    }
  }, [freqInput, tuneReceiver, zoom]);

  const handleTune = useCallback((nextFrequency: number) => {
    tuneReceiver(nextFrequency, false);
  }, [tuneReceiver]);

  const handleModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextMode = e.target.value as AudioMode;
    const cuts = MODE_CUTS[nextMode];

    setMode(nextMode);
    setLowCut(cuts.lowCut);
    setHighCut(cuts.highCut);
    audioStreamRef.current?.tune(frequency, nextMode, cuts.lowCut, cuts.highCut);
  }, [frequency]);

  const handleZoomChange = useCallback((delta: number) => {
    const nextZoom = Math.max(0, Math.min(14, zoom + delta));
    const nextViewCenter = nextZoom === 0 ? receiverCenterFreq : clampViewCenter(frequency, nextZoom);

    setZoom(nextZoom);
    setViewCenterFreq(nextViewCenter);
    wfStreamRef.current?.setView(nextZoom, nextViewCenter);
  }, [clampViewCenter, frequency, receiverCenterFreq, zoom]);

  const handleAgcToggle = useCallback(() => {
    if (!agcSupported) return;

    const nextAgc = !agc;
    setAgc(nextAgc);
    audioStreamRef.current?.setAgc(nextAgc);
  }, [agc, agcSupported]);

  return (
    <>
      <header className="sdr-header">
        <span className="sdr-title">{activeBackend?.name ?? 'SDR'}</span>
        <span className="sdr-host">
          {activeBackend ? `${activeBackend.url.hostname}:${activeBackend.url.port || (activeBackend.kind === 'kiwi' ? '8073' : '8070')}` : 'No backend configured'}
        </span>

        <span className="sep">|</span>

        <div className="ctrl-group">
          <span className="ctrl-label">Backend</span>
          <select
            className="mode-select"
            value={backend}
            onChange={e => setBackend(e.target.value as BackendKind)}
            disabled={connected}
          >
            {BACKENDS.map(candidate => (
              <option key={candidate.kind} value={candidate.kind}>{candidate.name}</option>
            ))}
          </select>
        </div>

        <div className="ctrl-group freq-display">
          <input
            className="freq-input"
            type="number"
            min={minFrequency}
            max={maxFrequency}
            step="0.1"
            value={freqInput}
            onChange={e => setFreqInput(e.target.value)}
            onKeyDown={handleFreqKeyDown}
            title="Frequency (kHz) — press Enter to tune"
          />
          <span className="freq-unit">kHz</span>
        </div>

        <div className="ctrl-group">
          <span className="ctrl-label">Mode</span>
          <select className="mode-select" value={mode} onChange={handleModeChange}>
            {availableModes.map(candidate => (
              <option key={candidate} value={candidate}>{candidate.toUpperCase()}</option>
            ))}
          </select>
        </div>

        <span className="sep">|</span>

        <div className="ctrl-group">
          <span className="ctrl-label">AGC</span>
          <button
            className={`btn ${agcSupported && agc ? 'active' : ''}`}
            onClick={handleAgcToggle}
            disabled={!agcSupported}
            title={agcSupported ? 'Toggle Automatic Gain Control' : 'OpenWebRX manages gain on the server side'}
          >
            {agcSupported ? (agc ? 'ON' : 'OFF') : 'N/A'}
          </button>
        </div>

        <div className="ctrl-group">
          <span className="ctrl-label">Vol</span>
          <input
            className="vol-slider"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={e => setVolume(parseFloat(e.target.value))}
          />
        </div>

        <span className="sep">|</span>

        <div className="ctrl-group">
          <span className="ctrl-label">Zoom</span>
          <button className="btn" onClick={() => handleZoomChange(-1)} title="Zoom out">-</button>
          <span style={{ color: '#c8d8e8', minWidth: '16px', textAlign: 'center' }}>{zoom}</span>
          <button className="btn" onClick={() => handleZoomChange(1)} title="Zoom in">+</button>
        </div>

        <span className="sep">|</span>

        <button className={`btn connect ${connected ? 'connected' : ''}`} onClick={connect}>
          {connected ? 'STOP' : 'CONNECT'}
        </button>

        <span style={{ color: connected ? '#00ff44' : '#445566', fontSize: '11px', marginLeft: '4px' }}>
          {status}
        </span>
      </header>

      {error && (
        <div className="error-banner">Warning: {error}</div>
      )}

      <Waterfall
        ref={wfRef}
        receiverBandwidth={receiverBandwidth}
        receiverCenterFreq={receiverCenterFreq}
        viewCenterFreq={viewCenterFreq}
        zoom={zoom}
        tuneFreq={frequency}
        lowCut={lowCut}
        highCut={highCut}
        minDb={-120}
        maxDb={-20}
        onTune={handleTune}
      />

      <SMeter rssi={rssi} unit={meterUnit} />
    </>
  );
}
