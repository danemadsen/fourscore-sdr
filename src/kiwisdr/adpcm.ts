// IMA-ADPCM decoder matching the KiwiSDR / kiwiclient implementation

const STEP_SIZE_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34,
  37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
  1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
  4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
  27086, 29794, 32767,
];

// Index adjustment for each 4-bit code (lower nibble first)
const INDEX_ADJUST_TABLE = [
  -1, -1, -1, -1,  // codes 0-3: step down
   2,  4,  6,  8,  // codes 4-7: step up
  -1, -1, -1, -1,  // codes 8-11 (negative, magnitude 0-3): step down
   2,  4,  6,  8,  // codes 12-15 (negative, magnitude 4-7): step up
];

function clamp(val: number, min: number, max: number): number {
  return val < min ? min : val > max ? max : val;
}

// Bytes per ADPCM block between SYNC words (matches openwebrx reference client)
const SYNC_PERIOD = 1000;
const SYNC_WORD = [83, 89, 78, 67]; // 'S','Y','N','C'

export class ImaAdpcmDecoder {
  private index = 0;
  private prev = 0;

  // State for decodeWithSync (maintained across calls)
  private syncPhase = 0;          // 0=hunt, 1=read state, 2=decode
  private syncSynchronized = 0;   // how many SYNC bytes matched so far
  private syncCounter = 0;        // bytes remaining until next SYNC
  private syncBuf = new Uint8Array(4);
  private syncBufIdx = 0;

  /** Called when server sends audio_adpcm_state=index,prev in a MSG */
  preset(index: number, prev: number): void {
    this.index = index;
    this.prev = prev;
  }

  reset(): void {
    this.index = 0;
    this.prev = 0;
    this.syncPhase = 0;
    this.syncSynchronized = 0;
    this.syncCounter = 0;
    this.syncBufIdx = 0;
  }

  private decodeSample(code: number): number {
    const step = STEP_SIZE_TABLE[this.index];
    this.index = clamp(this.index + INDEX_ADJUST_TABLE[code], 0, STEP_SIZE_TABLE.length - 1);

    let diff = step >> 3;
    if (code & 1) diff += step >> 2;
    if (code & 2) diff += step >> 1;
    if (code & 4) diff += step;
    if (code & 8) diff = -diff;

    const sample = clamp(this.prev + diff, -32768, 32767);
    this.prev = sample;
    return sample;
  }

  /** Decode a buffer of IMA-ADPCM nibbles into 16-bit PCM samples.
   *  Each input byte produces 2 output samples (lower nibble first). */
  decode(data: Uint8Array): Int16Array {
    const samples = new Int16Array(data.length * 2);
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      samples[i * 2]     = this.decodeSample(b & 0x0f);  // lower nibble first
      samples[i * 2 + 1] = this.decodeSample(b >> 4);    // upper nibble
    }
    return samples;
  }

  /**
   * Decode OpenWebRX-style ADPCM audio which embeds "SYNC" + codec state
   * every SYNC_PERIOD bytes. State is preserved across calls.
   */
  decodeWithSync(data: Uint8Array): Int16Array {
    const output = new Int16Array(data.length * 2);
    let oi = 0;

    for (let i = 0; i < data.length; i++) {
      switch (this.syncPhase) {
        case 0: // hunt for "SYNC" word
          if (data[i] === SYNC_WORD[this.syncSynchronized]) {
            this.syncSynchronized++;
          } else {
            this.syncSynchronized = 0;
          }
          if (this.syncSynchronized === 4) {
            this.syncBufIdx = 0;
            this.syncPhase = 1;
          }
          break;

        case 1: // read 4-byte codec state (stepIndex, predictor as two Int16LE)
          this.syncBuf[this.syncBufIdx++] = data[i];
          if (this.syncBufIdx === 4) {
            const state = new Int16Array(this.syncBuf.buffer);
            this.index = state[0];
            this.prev  = state[1];
            this.syncCounter = SYNC_PERIOD;
            this.syncPhase = 2;
          }
          break;

        case 2: // decode audio samples
          output[oi++] = this.decodeSample(data[i] & 0x0f);
          output[oi++] = this.decodeSample(data[i] >> 4);
          // OpenWebRX emits 1001 ADPCM bytes between SYNC blocks. Keep the
          // post-decrement check aligned with the reference client so we don't
          // desynchronize and drop a byte at each boundary.
          if (this.syncCounter-- === 0) {
            this.syncSynchronized = 0;
            this.syncPhase = 0;
          }
          break;
      }
    }

    return output.subarray(0, oi);
  }
}
