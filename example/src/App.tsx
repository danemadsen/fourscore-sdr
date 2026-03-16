import { useState, useRef, useCallback, useEffect } from 'react';
import { UniversalSDR, MODE_CUTS, AUDIO_MODES } from '@fourscore/sdr';
import type { AudioMode, SDRConfig, SDRProfile, SDRType, WaterfallData } from '@fourscore/sdr';
import { Waterfall, type WaterfallHandle } from './components/Waterfall';
import { SMeter } from './components/SMeter';
import PCMPlayer from './utilites/pcm';

const KIWI_URL = import.meta.env.VITE_KIWI_SDR_URL as string;
const OWRX_URL = import.meta.env.VITE_OPENWEBRX_SDR_URL as string;

function parseUrl(url: string, defaultPort: number) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: parseInt(parsed.port) || defaultPort };
}

const kiwiAddr = parseUrl(KIWI_URL, 8073);
const owrxAddr = parseUrl(OWRX_URL, 8073);

const OPENWEBRX_MODES: AudioMode[] = ['am', 'sam', 'lsb', 'usb', 'cw', 'nbfm', 'wfm'];

export default function App() {
  const [sdrType, setSdrType] = useState<SDRType>('kiwisdr');
  const [connected, setConnected] = useState(false);
  const [frequency, setFrequency] = useState(7200);
  const [freqInput, setFreqInput] = useState('7200');
  const [mode, setMode] = useState<AudioMode>('lsb');
  const [lowCut, setLowCut] = useState(MODE_CUTS.lsb.lowCut);
  const [highCut, setHighCut] = useState(MODE_CUTS.lsb.highCut);
  const [zoom, setZoom] = useState(0);
  const [centerFreq, setCenterFreq] = useState(15000);
  const [wfBandwidth, setWfBandwidth] = useState(30000);
  const [agc, setAgc] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [rssi, setRssi] = useState(-127);
  const [wfMinDb, setWfMinDb] = useState(-75);
  const [wfMaxDb, setWfMaxDb] = useState(-20);
  const [wfCanvasWidth, setWfCanvasWidth] = useState(1024);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('DISCONNECTED');
  const [owrxProfiles, setOwrxProfiles] = useState<SDRProfile[]>([]);
  const [owrxActiveProfile, setOwrxActiveProfile] = useState('');

  const sdrRef = useRef<UniversalSDR | null>(null);
  const wfRef = useRef<WaterfallHandle>(null);
  const playerRef = useRef<PCMPlayer | null>(null);

  const wfCanvasWidthRef = useRef(wfCanvasWidth);

  useEffect(() => { wfCanvasWidthRef.current = wfCanvasWidth; }, [wfCanvasWidth]);
  useEffect(() => { playerRef.current?.volume(volume); }, [volume]);

  const disconnect = useCallback(() => {
    sdrRef.current?.close();
    sdrRef.current = null;
    playerRef.current?.destroy();
    playerRef.current = null;
    setConnected(false);
    setStatus('DISCONNECTED');
    setRssi(-127);
  }, []);

  const handleConfig = useCallback((config: SDRConfig) => {
    setFrequency(config.frequency);
    setFreqInput(config.frequency.toFixed(1));
    setMode(config.mode);
    setLowCut(config.lowCut);
    setHighCut(config.highCut);
    if (config.agc !== undefined) setAgc(config.agc);
    setWfBandwidth(config.bandwidth);
    setCenterFreq(config.viewCenterFreq);
    setZoom(config.zoom);
    setWfMinDb(config.waterfallMin !== -150 ? config.waterfallMin : -120);
    setWfMaxDb(config.waterfallMax !== 0 ? config.waterfallMax : -20);
    if (config.zoom === 0 || config.type === 'kiwisdr') {
      setWfCanvasWidth(config.fftSize);
      wfCanvasWidthRef.current = config.fftSize;
    }

    if (config.type === 'openwebrx') {
      setOwrxProfiles(config.profiles ?? []);
      setOwrxActiveProfile(config.activeProfileId ?? '');
    } else {
      setOwrxProfiles([]);
      setOwrxActiveProfile('');
    }
  }, []);

  const handleWaterfall = useCallback((data: WaterfallData) => {
    if (data.bins.length !== wfCanvasWidthRef.current) {
      setWfCanvasWidth(data.bins.length);
      wfCanvasWidthRef.current = data.bins.length;
    }
    wfRef.current?.addRow(data);
  }, []);

  const connect = useCallback(() => {
    if (connected) {
      disconnect();
      return;
    }

    setError(null);
    setStatus('CONNECTING...');
    setOwrxProfiles([]);
    setOwrxActiveProfile('');

    if (!playerRef.current) {
      playerRef.current = new PCMPlayer({ inputCodec: 'Int16', sampleRate: 12000 });
    }

    const addr = sdrType === 'kiwisdr' ? kiwiAddr : owrxAddr;
    const sdr = new UniversalSDR(sdrType, {
      host: addr.host,
      port: addr.port,
      onOpen: () => {
        setConnected(true);
        setStatus('CONNECTED');
      },
      onClose: (code, reason) => {
        setConnected(false);
        setStatus(`DISCONNECTED (${code}${reason ? ': ' + reason : ''})`);
      },
      onAudio: ({ samples }) => {
        playerRef.current?.feed(samples);
      },
      onWaterfall: handleWaterfall,
      onError: err => {
        setError(err.message);
        setStatus('ERROR');
        setConnected(false);
      },
      onSMeter: setRssi,
      onConfig: handleConfig,
    });

    sdrRef.current = sdr;
    sdr.connect({
      frequency,
      mode,
      lowCut,
      highCut,
      sampleRate: playerRef.current.option.sampleRate,
      agc,
      zoom,
      centerFreq,
      maxDb: -20,
      minDb: -120,
      speed: 4,
    });
  }, [agc, centerFreq, connected, disconnect, frequency, handleConfig, handleWaterfall, highCut, lowCut, mode, sdrType, zoom]);

  const handleFreqKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;

    const nextFrequency = parseFloat(freqInput);
    if (isNaN(nextFrequency) || nextFrequency <= 0 || nextFrequency > 30000) return;

    setFreqInput(nextFrequency.toFixed(1));
    sdrRef.current?.tune(nextFrequency);
  }, [freqInput]);

  const handleTune = useCallback((nextFrequency: number) => {
    const tunedFrequency = Math.round(nextFrequency * 10) / 10;
    setFreqInput(tunedFrequency.toFixed(1));
    sdrRef.current?.tune(tunedFrequency);
  }, []);

  const handleModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextMode = e.target.value as AudioMode;
    sdrRef.current?.setMode(nextMode);
  }, []);

  const handleZoomChange = useCallback((delta: number) => {
    sdrRef.current?.adjustZoom(delta);
  }, []);

  const handleAgcToggle = useCallback(() => {
    sdrRef.current?.toggleAgc();
  }, []);

  return (
    <>
      <header className="sdr-header">
        <div className="ctrl-group">
          <button
            className={`btn ${sdrType === 'kiwisdr' ? 'active' : ''}`}
            disabled={connected}
            onClick={() => setSdrType('kiwisdr')}
          >KiwiSDR</button>
          <button
            className={`btn ${sdrType === 'openwebrx' ? 'active' : ''}`}
            disabled={connected}
            onClick={() => setSdrType('openwebrx')}
          >OpenWebRX</button>
        </div>

        <span className="sdr-host">
          {sdrType === 'kiwisdr' ? `${kiwiAddr.host}:${kiwiAddr.port}` : `${owrxAddr.host}:${owrxAddr.port}`}
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
            title="Frequency (kHz) - press Enter to tune"
          />
          <span className="freq-unit">kHz</span>
        </div>

        <div className="ctrl-group">
          <span className="ctrl-label">Mode</span>
          <select className="mode-select" value={mode} onChange={handleModeChange}>
            {(sdrType === 'openwebrx' ? OPENWEBRX_MODES : AUDIO_MODES).map(m => (
              <option key={m} value={m}>{m.toUpperCase()}</option>
            ))}
          </select>
        </div>

        {sdrType === 'openwebrx' && owrxProfiles.length > 0 && (
          <>
            <span className="sep">|</span>
            <div className="ctrl-group">
              <span className="ctrl-label">Profile</span>
              <select
                className="mode-select"
                value={owrxActiveProfile}
                onChange={e => {
                  const profileId = e.target.value;
                  setOwrxActiveProfile(profileId);
                  sdrRef.current?.selectProfile(profileId);
                }}
              >
                {owrxProfiles.map(profile => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
            </div>
          </>
        )}

        <span className="sep">|</span>

        {sdrType === 'kiwisdr' && (
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
          <button className="btn" onClick={() => handleZoomChange(-1)}>−</button>
          <span style={{ color: '#c8d8e8', minWidth: '16px', textAlign: 'center' }}>{zoom}</span>
          <button className="btn" onClick={() => handleZoomChange(1)}>+</button>
        </div>

        <span className="sep">|</span>

        <div className="ctrl-group">
          <span className="ctrl-label">Max dB</span>
          <input
            className="vol-slider"
            type="range"
            min="-100"
            max="60"
            step="5"
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
            type="range"
            min="-200"
            max="-20"
            step="5"
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
        centerFreq={centerFreq}
        totalBw={wfBandwidth}
        zoom={zoom}
        tuneFreq={frequency}
        lowCut={lowCut}
        highCut={highCut}
        minDb={wfMinDb}
        maxDb={wfMaxDb}
        canvasWidth={wfCanvasWidth}
        onTune={handleTune}
      />

      <SMeter rssi={rssi} />
    </>
  );
}
