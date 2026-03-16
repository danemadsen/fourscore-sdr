import { useState, useRef, useCallback, useEffect } from 'react';
import { KiwiSDR, OpenWebRX, MODE_CUTS, AUDIO_MODES } from '@fourscore/sdr';
import type { AudioStream, WaterfallStream, OpenWebRXStream, OpenWebRXProfile, OpenWebRXConfig, AudioMode, AudioData, OpenWebRXWaterfallData } from '@fourscore/sdr';
import { Waterfall, type WaterfallHandle } from './components/Waterfall';
import { SMeter } from './components/SMeter';
import PCMPlayer from './utilites/pcm';

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
  const [centerFreq, setCenterFreq]   = useState(15000);   // kHz, view center
  const [wfCenter, setWfCenter]       = useState(15000);   // kHz, SDR hardware center
  const [wfBandwidth, setWfBandwidth] = useState(30000);   // kHz, full SDR span
  const [agc, setAgc]                 = useState(true);
  const [volume, setVolume]           = useState(0.8);
  const [rssi, setRssi]               = useState(-127);
  const [wfMinDb, setWfMinDb]         = useState(-75);
  const [wfMaxDb, setWfMaxDb]         = useState(-20);
  const [wfCanvasWidth, setWfCanvasWidth] = useState(1024);
  const [error, setError]             = useState<string | null>(null);
  const [status, setStatus]           = useState('DISCONNECTED');
  const [owrxProfiles, setOwrxProfiles]         = useState<OpenWebRXProfile[]>([]);
  const [owrxActiveProfile, setOwrxActiveProfile] = useState('');

  // KiwiSDR — separate audio + waterfall streams
  const audioStreamRef = useRef<AudioStream | null>(null);
  const wfStreamRef    = useRef<WaterfallStream | null>(null);
  // OpenWebRX — single combined stream
  const owrxStreamRef  = useRef<OpenWebRXStream | null>(null);

  const wfRef = useRef<WaterfallHandle>(null);
  const playerRef = useRef<PCMPlayer | null>(null);

  // Refs kept in sync with state — safe to read inside stale event-handler closures
  const zoomRef        = useRef(zoom);
  const centerFreqRef  = useRef(centerFreq);
  const owrxSdrCenter  = useRef(0);   // kHz — SDR hardware center, set from config
  const owrxSdrBw      = useRef(0);   // kHz — full SDR bandwidth, set from config
  const owrxInitialStateAppliedRef = useRef(false);
  const pendingOwrxTuneRef = useRef<{ frequency: number; mode: AudioMode; lowCut: number; highCut: number } | null>(null);
  const wfCanvasWidthRef = useRef(wfCanvasWidth);
  useEffect(() => { zoomRef.current = zoom; },        [zoom]);
  useEffect(() => { centerFreqRef.current = centerFreq; }, [centerFreq]);
  useEffect(() => { wfCanvasWidthRef.current = wfCanvasWidth; }, [wfCanvasWidth]);

  const findOwrxProfileForTune = useCallback((freq: number, nextMode: AudioMode) => {
    const isAmFamily = ['am', 'amn', 'amw', 'sam', 'sal', 'sau', 'sas', 'qam'].includes(nextMode);
    if (isAmFamily && freq >= 520 && freq <= 1710) {
      return owrxProfiles.find(profile =>
        /\|am$/i.test(profile.id) || /am broadcast/i.test(profile.name),
      ) ?? null;
    }
    return null;
  }, [owrxProfiles]);

  const maybeSwitchOwrxProfileForTune = useCallback((freq: number, nextMode: AudioMode, nextLowCut: number, nextHighCut: number) => {
    const stream = owrxStreamRef.current;
    if (!stream || sdrType !== 'openwebrx') return false;

    const offsetHz = Math.round(freq * 1000) - Math.round(owrxSdrCenter.current * 1000);
    const withinBand = owrxSdrBw.current > 0 && Math.abs(offsetHz) <= (owrxSdrBw.current * 1000) / 2;
    if (withinBand) return false;

    const profile = findOwrxProfileForTune(freq, nextMode);
    if (!profile || profile.id === owrxActiveProfile) return false;

    pendingOwrxTuneRef.current = { frequency: freq, mode: nextMode, lowCut: nextLowCut, highCut: nextHighCut };
    owrxInitialStateAppliedRef.current = false;
    setOwrxActiveProfile(profile.id);
    stream.selectProfile(profile.id);
    return true;
  }, [findOwrxProfileForTune, owrxActiveProfile, sdrType]);

  const disconnect = useCallback(() => {
    audioStreamRef.current?.close();
    wfStreamRef.current?.close();
    owrxStreamRef.current?.close();
    audioStreamRef.current = null;
    wfStreamRef.current    = null;
    owrxStreamRef.current  = null;
    owrxInitialStateAppliedRef.current = false;
    pendingOwrxTuneRef.current = null;
    playerRef.current?.destroy();
    playerRef.current = null;
    setConnected(false);
    setStatus('DISCONNECTED');
    setRssi(-127);
  }, []);

  const connect = useCallback(() => {
    if (connected) { disconnect(); return; }

    setError(null);
    setStatus('CONNECTING...');
    owrxInitialStateAppliedRef.current = false;
    if (!playerRef.current) {
      playerRef.current = new PCMPlayer({ inputCodec: 'Int16', sampleRate: 12000 });
    }
    const outputRate = playerRef.current.option.sampleRate;

    if (sdrType === 'kiwi') {
      // ── KiwiSDR ────────────────────────────────────────────────────────────
      setWfMinDb(-110);
      setWfMaxDb(-20);
      setWfCanvasWidth(1024);
      const client = new KiwiSDR({ host: kiwiAddr.host, port: kiwiAddr.port });

      const astream = client.openAudioStream({ frequency, mode, lowCut, highCut, agc, sampleRate: outputRate });
      audioStreamRef.current = astream;
      astream.on('open',   () => { setConnected(true); setStatus('CONNECTED'); });
      astream.on('audio',  ({ samples, rssi: r }) => { playerRef.current?.feed(samples); setRssi(r); });
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

      const stream = client.connect({ frequency, mode, lowCut, highCut, outputRate });
      owrxStreamRef.current = stream;
      stream.on('open',      () => { setConnected(true); setStatus('CONNECTED'); });
      stream.on('profiles',  (profiles, activeId) => { setOwrxProfiles(profiles); setOwrxActiveProfile(activeId); });
      stream.on('audio',     ({ samples }: AudioData) => playerRef.current?.feed(samples));
      stream.on('smeter',    (r: number) => setRssi(r));
      stream.on('error',  (err: Error) => { setError(err.message); setStatus('ERROR'); setConnected(false); });
      stream.on('close',  (code: number, reason: string) => {
        owrxInitialStateAppliedRef.current = false;
        pendingOwrxTuneRef.current = null;
        setConnected(false);
        setStatus(`DISCONNECTED (${code}${reason ? ': ' + reason : ''})`);
      });

      stream.on('config', ({ centerFreq: cf, bandwidth, waterfallMin, waterfallMax, fftSize, startFreq, startMode, profileChanged }: OpenWebRXConfig) => {
        const cfKHz = cf / 1000;
        const bwKHz = bandwidth / 1000;
        owrxSdrCenter.current = cfKHz;
        owrxSdrBw.current     = bwKHz;
        setWfCenter(cfKHz);
        setWfBandwidth(bwKHz);
        setWfCanvasWidth(fftSize);
        setWfMinDb(waterfallMin !== -150 ? waterfallMin : -120);
        setWfMaxDb(waterfallMax !== 0    ? waterfallMax : -20);
        // Reset zoom view to full SDR band on (re)connect
        setCenterFreq(cfKHz);
        centerFreqRef.current = cfKHz;

        if (startFreq !== undefined && startMode !== undefined && (!owrxInitialStateAppliedRef.current || profileChanged)) {
          const tunedKHz = startFreq / 1000;
          const cuts = MODE_CUTS[startMode];
          setFrequency(tunedKHz);
          setFreqInput(tunedKHz.toFixed(1));
          setMode(startMode);
          setLowCut(cuts.lowCut);
          setHighCut(cuts.highCut);
          owrxInitialStateAppliedRef.current = true;
        }

        const pendingTune = pendingOwrxTuneRef.current;
        if (pendingTune && profileChanged) {
          pendingOwrxTuneRef.current = null;
          owrxStreamRef.current?.tune(
            pendingTune.frequency,
            pendingTune.mode,
            pendingTune.lowCut,
            pendingTune.highCut,
          );
        }
      });

      stream.on('waterfall', ({ bins }: OpenWebRXWaterfallData) => {
        // Resize canvas if actual bin count differs from what config reported
        // (config and in-flight frames can be out of sync during pipeline transitions)
        if (bins.length !== wfCanvasWidthRef.current) {
          setWfCanvasWidth(bins.length);
          wfCanvasWidthRef.current = bins.length;
        }

        const z = zoomRef.current;
        let displayBins: Float32Array = bins;
        if (z > 0) {
          // Client-side zoom: slice the center portion of the bins
          const sdrBw  = owrxSdrBw.current;
          const sdrCtr = owrxSdrCenter.current;
          const viewCtr = centerFreqRef.current;
          const visibleBw = sdrBw / Math.pow(2, z);
          const sdrStart  = sdrCtr - sdrBw / 2;
          const binStart  = Math.max(0,            Math.round((viewCtr - visibleBw / 2 - sdrStart) / sdrBw * bins.length));
          const binEnd    = Math.min(bins.length,  Math.round((viewCtr + visibleBw / 2 - sdrStart) / sdrBw * bins.length));
          displayBins = bins.slice(binStart, binEnd);
        }
        wfRef.current?.addRow({ bins: displayBins, sequence: 0, xBin: 0, zoom: 0, flags: 0 });
      });
    }
  }, [connected, disconnect, sdrType, frequency, mode, lowCut, highCut, agc, zoom, centerFreq]);

  useEffect(() => { playerRef.current?.volume(volume); }, [volume]);

  const handleFreqKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const f = parseFloat(freqInput);
    if (isNaN(f) || f <= 0 || f > 30000) return;
    setFrequency(f);
    setFreqInput(f.toFixed(1));
    if (zoom > 0) setCenterFreq(f);
    audioStreamRef.current?.tune(f, mode);
    if (!maybeSwitchOwrxProfileForTune(f, mode, lowCut, highCut)) {
      owrxStreamRef.current?.tune(f, mode, lowCut, highCut);
    }
    if (zoom > 0) wfStreamRef.current?.setView(zoom, f);
  }, [freqInput, mode, lowCut, highCut, zoom, maybeSwitchOwrxProfileForTune]);

  const handleTune = useCallback((freq: number) => {
    const f = Math.round(freq * 10) / 10;
    setFrequency(f);
    setFreqInput(f.toFixed(1));
    audioStreamRef.current?.tune(f, mode);
    if (!maybeSwitchOwrxProfileForTune(f, mode, lowCut, highCut)) {
      owrxStreamRef.current?.tune(f, mode, lowCut, highCut);
    }
    if (zoom > 0) {
      if (sdrType === 'kiwi') {
        const bw = 30000 / Math.pow(2, zoom);
        const half = bw / 2;
        const cf = Math.max(half, Math.min(30000 - half, f));
        setCenterFreq(cf);
        wfStreamRef.current?.setView(zoom, cf);
      } else {
        const sdrBw = owrxSdrBw.current;
        const sdrCtr = owrxSdrCenter.current;
        const visibleBw = sdrBw / Math.pow(2, zoom);
        const half = visibleBw / 2;
        setCenterFreq(Math.max(sdrCtr - sdrBw / 2 + half, Math.min(sdrCtr + sdrBw / 2 - half, f)));
      }
    }
  }, [mode, lowCut, highCut, zoom, sdrType, maybeSwitchOwrxProfileForTune]);

  const handleModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const m = e.target.value as AudioMode;
    const cuts = MODE_CUTS[m];
    setMode(m);
    setLowCut(cuts.lowCut);
    setHighCut(cuts.highCut);
    audioStreamRef.current?.tune(frequency, m, cuts.lowCut, cuts.highCut);
    if (!maybeSwitchOwrxProfileForTune(frequency, m, cuts.lowCut, cuts.highCut)) {
      owrxStreamRef.current?.tune(frequency, m, cuts.lowCut, cuts.highCut);
    }
  }, [frequency, maybeSwitchOwrxProfileForTune]);

  const handleZoomChange = useCallback((delta: number) => {
    const z = Math.max(0, Math.min(14, zoom + delta));
    setZoom(z);

    if (sdrType === 'kiwi') {
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
    } else {
      // OpenWebRX: client-side zoom, center on tuned frequency
      const sdrBw  = owrxSdrBw.current;
      const sdrCtr = owrxSdrCenter.current;
      if (z > 0) {
        const visibleBw = sdrBw / Math.pow(2, z);
        const half = visibleBw / 2;
        const cf = Math.max(sdrCtr - sdrBw / 2 + half, Math.min(sdrCtr + sdrBw / 2 - half, frequency));
        setCenterFreq(cf);
      } else {
        setCenterFreq(sdrCtr);
      }
    }
  }, [zoom, sdrType, frequency]);

  const handleAgcToggle = useCallback(() => {
    const next = !agc;
    setAgc(next);
    audioStreamRef.current?.setAgc(next);
  }, [agc]);

  // Waterfall view parameters
  const wfCenterProp = sdrType === 'openwebrx'
    ? (zoom === 0 ? wfCenter : centerFreq)
    : (zoom === 0 ? 15000 : centerFreq);
  const wfBwProp = sdrType === 'openwebrx' ? wfBandwidth : 30000;

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
            {(sdrType === 'openwebrx'
              ? (['am', 'sam', 'lsb', 'usb', 'cw', 'nbfm', 'wfm'] as const)
              : AUDIO_MODES
            ).map(m => (
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
                  const id = e.target.value;
                  setOwrxActiveProfile(id);
                  owrxStreamRef.current?.selectProfile(id);
                }}
              >
                {owrxProfiles.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </>
        )}

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
            type="range" min="-100" max="60" step="5"
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
