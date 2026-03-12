interface SMeterProps {
  rssi: number;
}

// S-unit thresholds (dBm) — S1 = -121, each S-unit ≈ 6 dB
const S_LEVELS = [
  { label: 'S1',  db: -121 },
  { label: 'S2',  db: -115 },
  { label: 'S3',  db: -109 },
  { label: 'S4',  db: -103 },
  { label: 'S5',  db: -97  },
  { label: 'S6',  db: -91  },
  { label: 'S7',  db: -85  },
  { label: 'S8',  db: -79  },
  { label: 'S9',  db: -73  },
  { label: '+10', db: -63  },
  { label: '+20', db: -53  },
  { label: '+30', db: -43  },
  { label: '+40', db: -33  },
  { label: '+50', db: -23  },
  { label: '+60', db: -13  },
];

const MIN_DB = -127;
const MAX_DB = -13;

export function SMeter({ rssi }: SMeterProps) {
  const pct = Math.max(0, Math.min(100, ((rssi - MIN_DB) / (MAX_DB - MIN_DB)) * 100));

  const sLabel = () => {
    for (let i = S_LEVELS.length - 1; i >= 0; i--) {
      if (rssi >= S_LEVELS[i].db) return S_LEVELS[i].label;
    }
    return 'S0';
  };

  const barColor = rssi >= -73 ? '#ff4444' : rssi >= -91 ? '#ffaa00' : '#00cc44';

  return (
    <div className="smeter">
      <div className="smeter-label">S-METER</div>
      <div className="smeter-track">
        <div className="smeter-bar" style={{ width: `${pct}%`, background: barColor }} />
        <div className="smeter-ticks">
          {S_LEVELS.map(s => (
            <span
              key={s.label}
              className="smeter-tick"
              style={{ left: `${((s.db - MIN_DB) / (MAX_DB - MIN_DB)) * 100}%` }}
            >
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <div className="smeter-readout">
        <span className="smeter-s">{sLabel()}</span>
        <span className="smeter-db">{rssi.toFixed(1)} dBm</span>
      </div>
    </div>
  );
}
