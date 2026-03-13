import type { AudioMode } from './types';

export interface ModeCuts {
  /** Low passband cut in Hz (negative for LSB/SAM lower) */
  lowCut: number;
  /** High passband cut in Hz */
  highCut: number;
}

export const MODE_CUTS: Record<AudioMode, ModeCuts> = {
  am:   { lowCut:   -4900, highCut:   4900 },
  amn:  { lowCut:   -2500, highCut:   2500 },
  amw:  { lowCut:   -6000, highCut:   6000 },
  sam:  { lowCut:   -4900, highCut:   4900 },
  sal:  { lowCut:   -4900, highCut:      0 },
  sau:  { lowCut:       0, highCut:   4900 },
  sas:  { lowCut:   -4900, highCut:   4900 },
  qam:  { lowCut:   -4900, highCut:   4900 },
  lsb:  { lowCut:   -2700, highCut:   -300 },
  lsn:  { lowCut:   -2400, highCut:   -300 },
  usb:  { lowCut:     300, highCut:   2700 },
  usn:  { lowCut:     300, highCut:   2400 },
  cw:   { lowCut:     300, highCut:    700 },
  cwn:  { lowCut:     470, highCut:    530 },
  nbfm: { lowCut:   -6000, highCut:   6000 },
  nnfm: { lowCut:   -3000, highCut:   3000 },
  wfm:  { lowCut: -100000, highCut: 100000 },
  iq:   { lowCut:   -5000, highCut:   5000 },
  drm:  { lowCut:   -5000, highCut:   5000 },
};

/** All supported audio modes in display order */
export const AUDIO_MODES: AudioMode[] = [
  'am', 'amn', 'amw',
  'sam', 'sal', 'sau', 'sas',
  'qam',
  'lsb', 'lsn',
  'usb', 'usn',
  'cw', 'cwn',
  'nbfm', 'nnfm', 'wfm',
  'iq',
  'drm',
];
