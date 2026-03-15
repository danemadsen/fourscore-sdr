import { OpenWebRXOptions, OpenWebRXStreamOptions } from '../types';
import { OpenWebRXStream } from './stream';

export class OpenWebRX {
  private readonly host: string;
  private readonly port: number;

  constructor(opts: OpenWebRXOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 8073;
  }

  /** Open a combined audio + waterfall stream to this receiver. */
  connect(opts: OpenWebRXStreamOptions): OpenWebRXStream {
    return new OpenWebRXStream(this.host, this.port, opts);
  }
}
