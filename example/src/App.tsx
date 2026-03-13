import { useState, useRef, useCallback, useEffect } from 'react';
import { KiwiSDR, OpenWebRX, MODE_CUTS, AUDIO_MODES } from '@fourscore/sdr';
import type { AudioStream, WaterfallStream, OpenWebRXStream, AudioMode, AudioData, WaterfallData, OpenWebRXWaterfallData } from '@fourscore/sdr';
import { Waterfall, type WaterfallHandle } from './components/Waterfall';
import { SMeter } from './components/SMeter';
import { useAudio } from './hooks/useAudio';

const KIWI_URL = import.meta.env.VITE_KIWI_SDR_URL as string;
const OWRX_URL = import.meta.env.VITE_OPENWEBRX_SDR_URL as string;

function parseUrl(url: string, defaultPort: number) {
  const p = new URL(url);
  return { host: p.hostname, port: parseInt(p.port) || defaultPort };
}

const kiwiAddr = parseUrl(KIWI_URL, 8073);
const owrxAddr = parseUrl(OWRX_URL, 8073);

type SdrType = 'kiwi' | 'openwebrx';

export default function App() {
  const [sdrType, setSdrType]         = useState<SdrType>('kiwi');
  const [connected, setConnected]     = useState(false);
  const [frequency, setFrequency]     = useState(7200);
  const [freqInput, setFreqInput]     = useState('7200');
  const [mode, setMode]               = useState<AudioMode>('lsb');
  const [lowCut, setLowCut]           = useState(MODE_CUTS.lsb.lowCut);
  const [highCut, setHighCut]         = useState(MODE_CUTS.lsb.highCut);
  const [zoom, setZoom]               = useState(0);
  const [centerFreq, setCenterFreq]   = useState(15000);   // kHz, KiwiSDR view center
  const [wfCenter, setWfCenter]       = useState(15000);   // kHz, actual Waterfall center
  const [wfBandwidth, setWfBandwidth] = useState(30000);   // kHz, actual Waterfall span
  const [agc, setAgc]                 = useState(true);
  const [volume, setVolume]           = useState(0.8);
  const [rssi, setRssi]               = useState(-127);
  const [wfMinDb, setWfMinDb]         = useState(-120);
  const [wfMaxDb, setWfMaxDb]         = useState(-20);
  const [error, setError]             = useState<string | null>(null);
  const [status, setStatus]           = useState('DISCONNECTED');

  // KiwiSDR — separate audio + waterfall streams
  const audioStreamRef = useRef<AudioStream | null>(null);
  const wfStreamRef    = useRef<WaterfallStream | null>(null);
  // OpenWebRX — single combined stream
  const owrxStreamRef  = useRef<OpenWebRXStream | null>(null);

  const wfRef = useRef<WaterfallHandle>(null);
  const audio = useAudio();

  const disconnect = useCallback(() => {
    audioStreamRef.current?.close();
    wfStreamRef.current?.close();
    owrxStreamRef.current?.close();
    audioStreamRef.current = null;
    wfStreamRef.current    = null;
    owrxStreamRef.current  = null;
    audio.stop();
    setConnected(false);
    setStatus('DISCONNECTED');
    setRssi(-127);
  }, [audio]);

  const connect = useCallback(() => {
    if (connected) { disconnect(); return; }

    setError(null);
    setStatus('CONNECTING...');
    audio.init();

    if (sdrType === 'kiwi') {
      // ── KiwiSDR ────────────────────────────────────────────────────────────
      setWfMinDb(-120);
      setWfMaxDb(-20);
      const client = new KiwiSDR({ host: kiwiAddr.host, port: kiwiAddr.port });

      const astream = client.openAudioStream({ frequency, mode, lowCut, highCut, agc, sampleRate: 12000 });
      audioStreamRef.current = astream;
      astream.on('open',   () => { setConnected(true); setStatus('CONNECTED'); });
      astream.on('audio',  ({ samples, rssi: r }) => { audio.play(samples); setRssi(r); });
      astream.on('smeter', r => setRssi(r));
      astream.on('error',  err => { setError(err.message); setStatus('ERROR'); setConnected(false); });
      astream.on('close',  (code, reason) => {
        setConnected(false);
        setStatus(`DISCONNECTED (${code}${reason ? ': ' + reason : ''})`);
      });

      const wfstream = client.openWaterfallStream({ zoom, centerFreq, speed: 4, maxDb: -20, minDb: -120 });
      wfStreamRef.current = wfstream;
      wfstream.on('waterfall', data => wfRef.current?.addRow(data));
      wfstream.on('error', err => setError(err.message));

      setWfCenter(zoom === 0 ? 15000 : centerFreq);
      setWfBandwidth(30000);

    } else {
      // ── OpenWebRX ──────────────────────────────────────────────────────────
      const client = new OpenWebRX({ host: owrxAddr.host, port: owrxAddr.port });

      const stream = client.connect({ frequency, mode, lowCut, highCut });
      owrxStreamRef.current = stream;
      stream.on('open',   () => { setConnected(true); setStatus('CONNECTED'); });
      stream.on('audio',  ({ samples }: AudioData) => audio.play(samples));
      stream.on('smeter', (r: number) => setRssi(r));
      stream.on('error',  (err: Error) => { setError(err.message); setStatus('ERROR'); setConnected(false); });
      stream.on('close',  (code: number, reason: string) => {
        setConnected(false);
        setStatus(`DISCONNECTED (${code}${reason ? ': ' + reason : ''})`);
      });
      // Config fires once — update the frequency axis then, not per waterfall frame
      stream.on('config', ({ centerFreq: cf, bandwidth, waterfallMin, waterfallMax }: { centerFreq: number; bandwidth: number; waterfallMin: number; waterfallMax: number }) => {
        setWfCenter(cf / 1000);
        setWfBandwidth(bandwidth / 1000);
        // Use server levels if they were explicitly set (not the default -150/0)
        setWfMinDb(waterfallMin !== -150 ? waterfallMin : -120);
        setWfMaxDb(waterfallMax !== 0    ? waterfallMax : -20);
      });
      stream.on('waterfall', ({ bins }: OpenWebRXWaterfallData) => {
        // Convert Float32 dB values to the KiwiSDR uint8 wire encoding (byte = dB + 255)
        const u8 = new Uint8Array(bins.length);
        for (let i = 0; i < bins.length; i++) {
          u8[i] = Math.max(0, Math.min(255, Math.round(bins[i] + 255)));
        }
        const data: WaterfallData = { bins: u8, sequence: 0, xBin: 0, zoom: 0, flags: 0 };
        wfRef.current?.addRow(data);
      });
    }
  }, [connected, disconnect, sdrType, frequency, mode, lowCut, highCut, agc, zoom, centerFreq, audio]);

  useEffect(() => { audio.setVolume(volume); }, [volume, audio]);

  const handleFreqKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const f = parseFloat(freqInput);
    if (isNaN(f) || f <= 0 || f > 30000) return;
    setFrequency(f);
    setFreqInput(f.toFixed(1));
    if (zoom > 0) setCenterFreq(f);   // only re-center when zoomed in
    audioStreamRef.current?.tune(f, mode);
    owrxStreamRef.current?.tune(f, mode, lowCut, highCut);
    if (zoom > 0) wfStreamRef.current?.setView(zoom, f);
  }, [freqInput, mode, lowCut, highCut, zoom]);

  const handleTune = useCallback((freq: number) => {
    const f = Math.round(freq * 10) / 10;
    setFrequency(f);
    setFreqInput(f.toFixed(1));
    audioStreamRef.current?.tune(f, mode);
    owrxStreamRef.current?.tune(f, mode, lowCut, highCut);
  }, [mode, lowCut, highCut]);

  const handleModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const m = e.target.value as AudioMode;
    const cuts = MODE_CUTS[m];
    setMode(m);
    setLowCut(cuts.lowCut);
    setHighCut(cuts.highCut);
    audioStreamRef.current?.tune(frequency, m, cuts.lowCut, cuts.highCut);
    owrxStreamRef.current?.tune(frequency, m, cuts.lowCut, cuts.highCut);
  }, [frequency]);

  const handleZoomChange = useCallback((delta: number) => {
    const z = Math.max(0, Math.min(14, zoom + delta));
    setZoom(z);
    if (z > 0) {
      const bw = 30000 / Math.pow(2, z);
      const cf = Math.max(bw / 2, Math.min(30000 - bw / 2, frequency));
      setCenterFreq(cf);
      setWfCenter(cf);
      wfStreamRef.current?.setView(z, cf);
    } else {
      setCenterFreq(15000);
      setWfCenter(15000);
      wfStreamRef.current?.setView(z, 15000);
    }
  }, [zoom, frequency]);

  const handleAgcToggle = useCallback(() => {
    const next = !agc;
    setAgc(next);
    audioStreamRef.current?.setAgc(next);
  }, [agc]);

  // Waterfall view parameters
  const wfCenterProp = sdrType === 'openwebrx' ? wfCenter : (zoom === 0 ? 15000 : centerFreq);
  const wfBwProp     = sdrType === 'openwebrx' ? wfBandwidth : 30000;

  return (
    <>
      <header className="sdr-header">
        <div className="ctrl-group">
          <button
            className={`btn ${sdrType === 'kiwi' ? 'active' : ''}`}
            disabled={connected}
            onClick={() => setSdrType('kiwi')}
          >KiwiSDR</button>
          <button
            className={`btn ${sdrType === 'openwebrx' ? 'active' : ''}`}
            disabled={connected}
            onClick={() => setSdrType('openwebrx')}
          >OpenWebRX</button>
        </div>

        <span className="sdr-host">
          {sdrType === 'kiwi' ? `${kiwiAddr.host}:${kiwiAddr.port}` : `${owrxAddr.host}:${owrxAddr.port}`}
        </span>

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
            {AUDIO_MODES.map(m => (
              <option key={m} value={m}>{m.toUpperCase()}</option>
            ))}
          </select>
        </div>

        <span className="sep">|</span>

        {sdrType === 'kiwi' && (
          <div className="ctrl-group">
            <span className="ctrl-label">AGC</span>
            <button className={`btn ${agc ? 'active' : ''}`} onClick={handleAgcToggle}>
              {agc ? 'ON' : 'OFF'}
            </button>
          </div>
        )}

        <div className="ctrl-group">
          <span className="ctrl-label">Vol</span>
          <input
            className="vol-slider"
            type="range" min="0" max="1" step="0.05"
            value={volume}
            onChange={e => setVolume(parseFloat(e.target.value))}
          />
        </div>

        {sdrType === 'kiwi' && (
          <>
            <span className="sep">|</span>
            <div className="ctrl-group">
              <span className="ctrl-label">Zoom</span>
              <button className="btn" onClick={() => handleZoomChange(-1)}>−</button>
              <span style={{ color: '#c8d8e8', minWidth: '16px', textAlign: 'center' }}>{zoom}</span>
              <button className="btn" onClick={() => handleZoomChange(1)}>+</button>
            </div>
          </>
        )}

        <span className="sep">|</span>

        <div className="ctrl-group">
          <span className="ctrl-label">Max dB</span>
          <input
            className="vol-slider"
            type="range" min="-100" max="0" step="5"
            value={wfMaxDb}
            onChange={e => setWfMaxDb(parseInt(e.target.value))}
            title={`Waterfall max: ${wfMaxDb} dB`}
          />
          <span style={{ color: '#c8d8e8', fontSize: '10px', minWidth: '28px' }}>{wfMaxDb}</span>
        </div>

        <div className="ctrl-group">
          <span className="ctrl-label">Min dB</span>
          <input
            className="vol-slider"
            type="range" min="-200" max="-20" step="5"
            value={wfMinDb}
            onChange={e => setWfMinDb(parseInt(e.target.value))}
            title={`Waterfall min: ${wfMinDb} dB`}
          />
          <span style={{ color: '#c8d8e8', fontSize: '10px', minWidth: '28px' }}>{wfMinDb}</span>
        </div>

        <span className="sep">|</span>

        <button className={`btn connect ${connected ? 'connected' : ''}`} onClick={connect}>
          {connected ? '⏹ DISCONNECT' : '▶ CONNECT'}
        </button>

        <span style={{ color: connected ? '#00ff44' : '#445566', fontSize: '11px', marginLeft: '4px' }}>
          {status}
        </span>
      </header>

      {error && <div className="error-banner">⚠ {error}</div>}

      <Waterfall
        ref={wfRef}
        centerFreq={wfCenterProp}
        totalBw={wfBwProp}
        zoom={sdrType === 'kiwi' ? zoom : 0}
        tuneFreq={frequency}
        lowCut={lowCut}
        highCut={highCut}
        minDb={wfMinDb}
        maxDb={wfMaxDb}
        onTune={handleTune}
      />

      <SMeter rssi={rssi} />
    </>
  );
}
