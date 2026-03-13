import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
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
  zoom: number;
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
  ({ centerFreq, zoom, minDb, maxDb, onTune }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rowBufRef = useRef<ImageData | null>(null);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      rowBufRef.current = ctx.createImageData(CANVAS_W, 1);
    }, []);

    const addRow = useCallback((data: WaterfallData) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Scroll existing content down by 1 pixel
      const existing = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H - 1);
      ctx.putImageData(existing, 0, 1);

      // Write new row at top
      const row = rowBufRef.current ?? ctx.createImageData(CANVAS_W, 1);
      const pixels = row.data;
      const bins = data.bins;
      const len = Math.min(bins.length, CANVAS_W);
      const range = maxDb - minDb || 1;
      for (let i = 0; i < len; i++) {
        // Server encodes dBm as: byte = dBm + 255  →  dBm = byte - 255
        const dBm = bins[i] - 255;
        const v = Math.max(0, Math.min(255, Math.round((dBm - minDb) / range * 255)));
        pixels[i * 4 + 0] = COLOR_LUT[v * 3 + 0];
        pixels[i * 4 + 1] = COLOR_LUT[v * 3 + 1];
        pixels[i * 4 + 2] = COLOR_LUT[v * 3 + 2];
        pixels[i * 4 + 3] = 255;
      }
      ctx.putImageData(row, 0, 0);
    }, [minDb, maxDb]);

    useImperativeHandle(ref, () => ({ addRow }), [addRow]);

    const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const bw = 30000 / Math.pow(2, zoom);
      const freq = centerFreq - bw / 2 + x * bw;
      onTune(Math.max(0, Math.min(30000, freq)));
    }, [centerFreq, zoom, onTune]);

    // Frequency axis ticks
    const bw = 30000 / Math.pow(2, zoom);
    const fStart = centerFreq - bw / 2;
    const fEnd = centerFreq + bw / 2;
    const tickStep = bw > 5000 ? 1000 : bw > 500 ? 100 : 10;
    const ticks: { pct: number; label: string }[] = [];
    const firstTick = Math.ceil(fStart / tickStep) * tickStep;
    for (let f = firstTick; f <= fEnd; f += tickStep) {
      ticks.push({ pct: (f - fStart) / bw * 100, label: (f / 1000).toFixed(f % 1000 === 0 ? 0 : 2) });
    }

    return (
      <div className="waterfall-wrapper">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="waterfall-canvas"
          onClick={handleClick}
        />
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
