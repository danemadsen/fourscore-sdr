import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle, useState } from 'react';
import type { WaterfallData } from '@fourscore/sdr';

// Precomputed color LUT: bin value 0-255 -> [r, g, b]
const COLOR_LUT = new Uint8Array(256 * 3);
(function buildLut() {
  const stops: [number, [number, number, number]][] = [
    [0,   [0,   0,   0  ]],
    [32,  [0,   0,   80 ]],
    [80,  [0,   0,   220]],
    [120, [0,   160, 255]],
    [160, [0,   255, 120]],
    [200, [200, 255, 0  ]],
    [230, [255, 180, 0  ]],
    [255, [255, 0,   0  ]],
  ];
  for (let v = 0; v < 256; v++) {
    let r = 0, g = 0, b = 0;
    for (let s = 0; s < stops.length - 1; s++) {
      const [v0, c0] = stops[s];
      const [v1, c1] = stops[s + 1];
      if (v >= v0 && v <= v1) {
        const t = (v - v0) / (v1 - v0);
        r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
        g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
        b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
        break;
      }
    }
    COLOR_LUT[v * 3 + 0] = r;
    COLOR_LUT[v * 3 + 1] = g;
    COLOR_LUT[v * 3 + 2] = b;
  }
})();

interface WaterfallProps {
  centerFreq: number;
  /** Total bandwidth of the view at zoom=0, in kHz. Defaults to 30000. */
  totalBw?: number;
  zoom: number;
  tuneFreq: number;
  lowCut: number;   // Hz offset from tuneFreq
  highCut: number;  // Hz offset from tuneFreq
  minDb: number;
  maxDb: number;
  onTune: (freq: number) => void;
}

export interface WaterfallHandle {
  addRow(data: WaterfallData): void;
}

const CANVAS_W = 1024;
const CANVAS_H = 300;

export const Waterfall = forwardRef<WaterfallHandle, WaterfallProps>(
  ({ centerFreq, totalBw = 30000, zoom, tuneFreq, lowCut, highCut, minDb, maxDb, onTune }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rowBufRef = useRef<ImageData | null>(null);
    const [hoverFreq, setHoverFreq] = useState<number | null>(null);
    const [hoverX, setHoverX] = useState(0);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      rowBufRef.current = ctx.createImageData(CANVAS_W, 1);
    }, []);

    // Clear canvas when view changes so overlays stay aligned with incoming data
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }, [zoom, centerFreq]);

    const bw = totalBw / Math.pow(2, zoom);
    const fStart = centerFreq - bw / 2;
    const fEnd = centerFreq + bw / 2;

    const addRow = useCallback((data: WaterfallData) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const existing = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H - 1);
      ctx.putImageData(existing, 0, 1);

      const row = rowBufRef.current ?? ctx.createImageData(CANVAS_W, 1);
      const pixels = row.data;
      const bins = data.bins;
      const isFloat = bins instanceof Float32Array;
      const range = maxDb - minDb || 1;
      for (let i = 0; i < CANVAS_W; i++) {
        // Nearest-neighbour scale: map canvas pixel i → bin index
        const binIdx = Math.min(bins.length - 1, Math.floor(i * bins.length / CANVAS_W));
        // Float32Array = raw dB (OpenWebRX); Uint8Array = KiwiSDR encoding (byte = dBm+255)
        const dBm = isFloat ? (bins as Float32Array)[binIdx] : (bins as Uint8Array)[binIdx] - 255;
        const v = Math.max(0, Math.min(255, Math.round((dBm - minDb) / range * 255)));
        pixels[i * 4 + 0] = COLOR_LUT[v * 3 + 0];
        pixels[i * 4 + 1] = COLOR_LUT[v * 3 + 1];
        pixels[i * 4 + 2] = COLOR_LUT[v * 3 + 2];
        pixels[i * 4 + 3] = 255;
      }
      ctx.putImageData(row, 0, 0);
    }, [minDb, maxDb]);

    useImperativeHandle(ref, () => ({ addRow }), [addRow]);

    const freqToPercent = (f: number) => (f - fStart) / bw * 100;
    const tuneX = freqToPercent(tuneFreq);

    const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const bwLocal = totalBw / Math.pow(2, zoom);
      const freq = centerFreq - bwLocal / 2 + x * bwLocal;
      onTune(Math.max(0, Math.min(centerFreq + bwLocal / 2, freq)));
    }, [centerFreq, totalBw, zoom, onTune]);

    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const bwLocal = totalBw / Math.pow(2, zoom);
      const freq = centerFreq - bwLocal / 2 + x * bwLocal;
      setHoverFreq(Math.max(0, Math.min(centerFreq + bwLocal / 2, freq)));
      setHoverX(e.clientX - rect.left);
    }, [centerFreq, totalBw, zoom]);

    const handleMouseLeave = useCallback(() => setHoverFreq(null), []);

    // Frequency axis ticks
    const tickStep = bw > 5000 ? 1000 : bw > 500 ? 100 : 10;
    const ticks: { pct: number; label: string }[] = [];
    const firstTick = Math.ceil(fStart / tickStep) * tickStep;
    for (let f = firstTick; f <= fEnd; f += tickStep) {
      ticks.push({ pct: freqToPercent(f), label: (f / 1000).toFixed(f % 1000 === 0 ? 0 : 2) });
    }

    return (
      <div className="waterfall-wrapper">
        <div style={{ position: 'relative' }}>
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            className="waterfall-canvas"
            onClick={handleClick}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          />
          {/* Passband highlight */}
          {tuneX >= 0 && tuneX <= 100 && (() => {
            const pbLeft = freqToPercent(tuneFreq + lowCut / 1000);
            const pbRight = freqToPercent(tuneFreq + highCut / 1000);
            if (pbRight < 0 || pbLeft > 100) return null;
            const clampedLeft = Math.max(0, pbLeft);
            const clampedRight = Math.min(100, pbRight);
            return (
              <div style={{
                position: 'absolute', top: 0, bottom: 0,
                left: `${clampedLeft}%`,
                width: `${clampedRight - clampedLeft}%`,
                minWidth: '2px',
                background: 'rgba(255, 255, 100, 0.2)',
                border: '1px solid rgba(255, 255, 100, 0.5)',
                boxSizing: 'border-box',
                pointerEvents: 'none',
              }} />
            );
          })()}
          {/* Tuning cursor */}
          {tuneX >= 0 && tuneX <= 100 && (
            <div style={{
              position: 'absolute', top: 0, bottom: 0,
              left: `${tuneX}%`, width: '1px',
              background: 'rgba(255,255,255,0.8)',
              pointerEvents: 'none',
            }}>
              <span style={{
                position: 'absolute', top: 4, left: 3,
                color: '#fff', fontSize: '11px', fontFamily: 'monospace',
                background: 'rgba(0,0,0,0.6)', padding: '1px 3px',
                whiteSpace: 'nowrap',
              }}>
                {(tuneFreq / 1000).toFixed(3)} MHz
              </span>
            </div>
          )}
          {/* Hover tooltip */}
          {hoverFreq !== null && (
            <div style={{
              position: 'absolute', bottom: 24, pointerEvents: 'none',
              left: Math.min(hoverX, CANVAS_W - 90),
              color: '#fff', fontSize: '11px', fontFamily: 'monospace',
              background: 'rgba(0,0,0,0.7)', padding: '2px 5px',
              whiteSpace: 'nowrap',
            }}>
              {(hoverFreq / 1000).toFixed(3)} MHz
            </div>
          )}
        </div>
        <div className="freq-axis">
          {ticks.map(t => (
            <span key={t.pct} className="freq-tick" style={{ left: `${t.pct}%` }}>
              {t.label}
            </span>
          ))}
        </div>
      </div>
    );
  }
);
