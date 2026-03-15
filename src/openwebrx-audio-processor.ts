declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;

interface ProcessorOptions {
  processorOptions?: {
    maxBufferSize?: number;
  };
}

class OpenWebRXAudioProcessor extends AudioWorkletProcessor {
  private readonly bufferSize: number;
  private readonly audioBuffer: Float32Array;
  private inPos = 0;
  private outPos = 0;
  private samplesProcessed = 0;

  constructor(options?: unknown) {
    super(options);
    const processorOptions = (options as ProcessorOptions | undefined)?.processorOptions;
    const requestedSize = processorOptions?.maxBufferSize ?? 0;
    this.bufferSize = Math.max(128, Math.round(requestedSize / 128) * 128);
    this.audioBuffer = new Float32Array(this.bufferSize);

    this.port.addEventListener('message', (event: MessageEvent<Float32Array | string>) => {
      if (typeof event.data === 'string') {
        const json = JSON.parse(event.data) as { cmd?: string };
        if (json.cmd === 'getStats') this.reportStats();
        return;
      }

      const chunk = event.data;
      if (this.inPos + chunk.length <= this.bufferSize) {
        this.audioBuffer.set(chunk, this.inPos);
      } else {
        const remaining = this.bufferSize - this.inPos;
        this.audioBuffer.set(chunk.subarray(0, remaining), this.inPos);
        this.audioBuffer.set(chunk.subarray(remaining));
      }
      this.inPos = (this.inPos + chunk.length) % this.bufferSize;
    });
    this.port.addEventListener('messageerror', console.error);
    this.port.start();
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.remaining() < 128) {
      outputs[0].forEach(output => output.fill(0));
      return true;
    }
    outputs[0].forEach((output) => {
      output.set(this.audioBuffer.subarray(this.outPos, this.outPos + 128));
    });
    this.outPos = (this.outPos + 128) % this.bufferSize;
    this.samplesProcessed += 128;
    return true;
  }

  private remaining(): number {
    const mod = (this.inPos - this.outPos) % this.bufferSize;
    return mod >= 0 ? mod : mod + this.bufferSize;
  }

  private reportStats(): void {
    this.port.postMessage(JSON.stringify({
      buffersize: this.remaining(),
      samplesProcessed: this.samplesProcessed,
    }));
    this.samplesProcessed = 0;
  }
}

registerProcessor('openwebrx-audio-processor', OpenWebRXAudioProcessor);
