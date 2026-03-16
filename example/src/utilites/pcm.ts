export type PCMInputCodec = 'Int8' | 'Int16' | 'Int32' | 'Float32'

export type PCMTypedArray = Int8Array | Int16Array | Int32Array | Float32Array

export type PCMTypedArrayConstructor = {
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): PCMTypedArray
  new (length: number): PCMTypedArray
  new (array: ArrayLike<number>): PCMTypedArray
}

export interface PCMPlayerOptions {
  inputCodec?: PCMInputCodec
  channels?: number
  sampleRate?: number
  flushTime?: number
  fftSize?: 32 | 64 | 128 | 256 | 512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768
  onstatechange?: (node: AudioContext, event: Event, state: AudioContextState) => void
  onended?: (node: AudioBufferSourceNode, event: Event) => void
}

type PCMInputData = ArrayBuffer | Int8Array | Int16Array | Int32Array | Float32Array

export default class PCMPlayer {
  public readonly option: Required<Omit<PCMPlayerOptions, 'onstatechange' | 'onended'>> &
    Pick<PCMPlayerOptions, 'onstatechange' | 'onended'>

  public audioCtx!: AudioContext
  public gainNode!: GainNode
  public analyserNode!: AnalyserNode
  public samples: Float32Array = new Float32Array()
  public interval!: ReturnType<typeof setInterval>

  private startTime = 0
  private convertValue!: number
  private TypedArrayConstructor!: PCMTypedArrayConstructor

  constructor(options: PCMPlayerOptions = {}) {
    this.option = {
      inputCodec: 'Int16',
      channels: 1,
      sampleRate: 8000,
      flushTime: 1000,
      fftSize: 2048,
      onstatechange: options.onstatechange,
      onended: options.onended,
      ...options
    }

    this.convertValue = this.getConvertValue(this.option.inputCodec)
    this.TypedArrayConstructor = this.getTypedArray(this.option.inputCodec)

    this.initAudioContext()
    this.bindAudioContextEvent()

    this.interval = setInterval(() => {
      this.flush()
    }, this.option.flushTime)
  }

  private getConvertValue(codec: PCMInputCodec): number {
    switch (codec) {
      case 'Int8':
        return 128
      case 'Int16':
        return 32768
      case 'Int32':
        return 2147483648
      case 'Float32':
        return 1
      default:
        throw new Error('Unsupported codec')
    }
  }

  private getTypedArray(codec: PCMInputCodec): PCMTypedArrayConstructor {
    switch (codec) {
      case 'Int8':
        return Int8Array
      case 'Int16':
        return Int16Array
      case 'Int32':
        return Int32Array
      case 'Float32':
        return Float32Array
      default:
        throw new Error('Unsupported codec')
    }
  }

  private initAudioContext() {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    if (!AudioContextClass) {
      throw new Error('Web Audio API is not supported in this environment')
    }

    this.audioCtx = new AudioContextClass()
    this.gainNode = this.audioCtx.createGain()
    this.gainNode.gain.value = 0.1
    this.gainNode.connect(this.audioCtx.destination)

    this.analyserNode = this.audioCtx.createAnalyser()
    this.analyserNode.fftSize = this.option.fftSize

    this.startTime = this.audioCtx.currentTime
  }

  static isTypedArray(data: unknown): data is PCMInputData {
    return (
      data instanceof ArrayBuffer ||
      data instanceof Int8Array ||
      data instanceof Int16Array ||
      data instanceof Int32Array ||
      data instanceof Float32Array
    )
  }

  private isSupported(data: unknown): data is PCMInputData {
    if (!PCMPlayer.isTypedArray(data)) {
      throw new Error('Data must be an ArrayBuffer or TypedArray')
    }
    return true
  }

  private getFormattedValue(data: PCMInputData): Float32Array {
    const typed = data instanceof ArrayBuffer ? new this.TypedArrayConstructor(data) : new this.TypedArrayConstructor(data.buffer)

    const float32 = new Float32Array(typed.length)
    for (let i = 0; i < typed.length; i++) {
      float32[i] = typed[i] / this.convertValue
    }
    return float32
  }

  feed(data: PCMInputData) {
    this.isSupported(data)

    const formatted = this.getFormattedValue(data)
    const merged = new Float32Array(this.samples.length + formatted.length)

    merged.set(this.samples, 0)
    merged.set(formatted, this.samples.length)

    this.samples = merged
  }

  volume(volume: number) {
    this.gainNode.gain.value = volume
  }

  destroy() {
    if (this.interval) clearInterval(this.interval)
    this.samples = new Float32Array()
    void this.audioCtx?.close()
  }

  private flush() {
    if (!this.samples.length) return

    const bufferSource = this.audioCtx.createBufferSource()

    if (typeof this.option.onended === 'function') {
      bufferSource.onended = (event) => {
        this.option.onended?.(bufferSource, event)
      }
    }

    const length = this.samples.length / this.option.channels
    const audioBuffer = this.audioCtx.createBuffer(this.option.channels, length, this.option.sampleRate)

    for (let channel = 0; channel < this.option.channels; channel++) {
      const audioData = audioBuffer.getChannelData(channel)
      let offset = channel
      let fadeOut = 50

      for (let i = 0; i < length; i++) {
        audioData[i] = this.samples[offset] ?? 0

        if (i < 50) {
          audioData[i] = (audioData[i] * i) / 50
        }

        if (i >= length - 51) {
          audioData[i] = (audioData[i] * fadeOut--) / 50
        }

        offset += this.option.channels
      }
    }

    if (this.startTime < this.audioCtx.currentTime) {
      this.startTime = this.audioCtx.currentTime
    }

    bufferSource.buffer = audioBuffer
    bufferSource.connect(this.gainNode)
    bufferSource.connect(this.analyserNode)
    bufferSource.start(this.startTime)

    this.startTime += audioBuffer.duration
    this.samples = new Float32Array()
  }

  async pause() {
    await this.audioCtx.suspend()
  }

  async continue() {
    await this.audioCtx.resume()
  }

  private bindAudioContextEvent() {
    if (typeof this.option.onstatechange === 'function') {
      this.audioCtx.onstatechange = (event) => {
        this.option.onstatechange?.(this.audioCtx, event, this.audioCtx.state)
      }
    }
  }
}