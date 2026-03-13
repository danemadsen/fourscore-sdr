import { useState, useRef, useCallback, useEffect } from 'react';
import { KiwiSDR } from '@fourscore/sdr';
import type { AudioStream, WaterfallStream, AudioMode } from '@fourscore/sdr';
import { Waterfall, type WaterfallHandle } from './components/Waterfall';
import { SMeter } from './components/SMeter';
import { useAudio } from './hooks/useAudio';

const SDR_URL = import.meta.env.VITE_SDR_URL as string;
const parsed = new URL(SDR_URL);
const SDR_HOST = parsed.hostname;
const SDR_PORT = parseInt(parsed.port) || 8073;

const MODES: AudioMode[] = ['am', 'amn', 'amw', 'lsb', 'usb', 'cw', 'cwn', 'nbfm', 'iq'];

export default function App() {
  const [connected, setConnected] = useState(false);
  const [frequency, setFrequency] = useState(7200);
  const [freqInput, setFreqInput] = useState('7200');
  const [mode, setMode] = useState<AudioMode>('lsb');
  const [zoom, setZoom] = useState(0);
  const [centerFreq, setCenterFreq] = useState(7200);
  const [agc, setAgc] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [rssi, setRssi] = useState(-127);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('DISCONNECTED');

  const audioStreamRef = useRef<AudioStream | null>(null);
  const wfStreamRef = useRef<WaterfallStream | null>(null);
  const kiwiRef = useRef<KiwiSDR | null>(null);
  const wfRef = useRef<WaterfallHandle>(null);

  const audio = useAudio();

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

  const connect = useCallback(() => {
    if (connected) {
      disconnect();
      return;
    }

    setError(null);
    setStatus('CONNECTING...');
    audio.init();

    const kiwi = new KiwiSDR({ host: SDR_HOST, port: SDR_PORT });
    kiwiRef.current = kiwi;

    // Audio stream
    const astream = kiwi.openAudioStream({
      frequency,
      mode,
      agc,
      sampleRate: 12000,
    });
    audioStreamRef.current = astream;

    astream.on('open', () => {
      setConnected(true);
      setStatus('CONNECTED');
    });

    astream.on('audio', ({ samples, rssi: r }) => {
      console.log('[kiwi audio SND packet] samples:', samples.length, 'rssi:', r);
      audio.play(samples);
      setRssi(r);
    });

    astream.on('smeter', (rssi) => {
      console.log('[kiwi smeter]', rssi);
    });

    astream.on('msg', (params) => {
      console.log('[kiwi audio msg]', params);
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

    // Waterfall stream
    const wfstream = kiwi.openWaterfallStream({
      zoom,
      centerFreq,
      speed: 4,
      maxDb: -20,
      minDb: -120,
    });
    wfStreamRef.current = wfstream;

    wfstream.on('waterfall', (data) => {
      console.log('[kiwi WF packet] bins:', data.bins.length);
      wfRef.current?.addRow(data);
    });

    wfstream.on('msg', (params) => {
      console.log('[kiwi wf msg]', params);
    });

    wfstream.on('open', () => {
      console.log('[kiwi wf open]');
    });

    wfstream.on('error', (err) => {
      console.log('[kiwi wf error]', err.message);
      setError(err.message);
    });

    wfstream.on('close', (code: number, reason: string) => {
      console.log('[kiwi wf close]', code, reason);
    });
  }, [connected, disconnect, frequency, mode, agc, zoom, centerFreq, audio]);

  // Update volume without reconnecting
  useEffect(() => {
    audio.setVolume(volume);
  }, [volume, audio]);

  const handleFreqKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const f = parseFloat(freqInput);
      if (!isNaN(f) && f > 0 && f <= 30000) {
        setFrequency(f);
        setCenterFreq(f);
        audioStreamRef.current?.tune(f, mode);
        wfStreamRef.current?.setView(zoom, f);
      }
    }
  }, [freqInput, mode, zoom]);

  const handleTune = useCallback((freq: number) => {
    const f = Math.round(freq * 10) / 10;
    setFrequency(f);
    setCenterFreq(f);
    setFreqInput(f.toFixed(1));
    audioStreamRef.current?.tune(f, mode);
  }, [mode]);

  const handleModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const m = e.target.value as AudioMode;
    setMode(m);
    audioStreamRef.current?.tune(frequency, m);
  }, [frequency]);

  const handleZoomChange = useCallback((delta: number) => {
    const z = Math.max(0, Math.min(14, zoom + delta));
    setZoom(z);
    wfStreamRef.current?.setView(z, centerFreq);
  }, [zoom, centerFreq]);

  const handleAgcToggle = useCallback(() => {
    const next = !agc;
    setAgc(next);
    audioStreamRef.current?.setAgc(next);
  }, [agc]);

  return (
    <>
      <header className="sdr-header">
        <span className="sdr-title">KiwiSDR</span>
        <span className="sdr-host">{SDR_HOST}:{SDR_PORT}</span>

        <span className="sep">|</span>

        <div className="ctrl-group freq-display">
          <input
            className="freq-input"
            type="number"
            min="0"
            max="30000"
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
            {MODES.map(m => (
              <option key={m} value={m}>{m.toUpperCase()}</option>
            ))}
          </select>
        </div>

        <span className="sep">|</span>

        <div className="ctrl-group">
          <span className="ctrl-label">AGC</span>
          <button
            className={`btn ${agc ? 'active' : ''}`}
            onClick={handleAgcToggle}
            title="Toggle Automatic Gain Control"
          >
            {agc ? 'ON' : 'OFF'}
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
          <button className="btn" onClick={() => handleZoomChange(-1)} title="Zoom out">−</button>
          <span style={{ color: '#c8d8e8', minWidth: '16px', textAlign: 'center' }}>{zoom}</span>
          <button className="btn" onClick={() => handleZoomChange(1)} title="Zoom in">+</button>
        </div>

        <span className="sep">|</span>

        <button
          className={`btn connect ${connected ? 'connected' : ''}`}
          onClick={connect}
        >
          {connected ? '⏹ DISCONNECT' : '▶ CONNECT'}
        </button>

        <span style={{ color: connected ? '#00ff44' : '#445566', fontSize: '11px', marginLeft: '4px' }}>
          {status}
        </span>
      </header>

      {error && (
        <div className="error-banner">⚠ {error}</div>
      )}

      <Waterfall
        ref={wfRef}
        centerFreq={centerFreq}
        zoom={zoom}
        minDb={-120}
        maxDb={-20}
        onTune={handleTune}
      />

      <SMeter rssi={rssi} />
    </>
  );
}
