import { parseMsgBody } from '../utils/msg';

const KEEPALIVE_INTERVAL_MS = 5000;

class EventEmitter {
  private _listeners: Map<string, ((...args: any[]) => void)[]> = new Map();

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    list.push(listener);
    this._listeners.set(event, list);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    this._listeners.set(event, list.filter(l => l !== listener));
    return this;
  }

  protected emit(event: string, ...args: any[]): void {
    const list = this._listeners.get(event) ?? [];
    for (const listener of list) listener(...args);
  }
}

const ascii = new TextDecoder('windows-1252');
const utf8 = new TextDecoder('utf-8');

export abstract class BaseStream extends EventEmitter {
  protected ws: WebSocket;
  private keepaliveTimer: number | null = null;
  private closed = false;

  constructor(
    protected readonly host: string,
    protected readonly port: number,
    streamType: 'SND' | 'W/F',
    password: string,
    username: string,
  ) {
    super();

    const timestamp = Math.floor(Date.now() / 1000);
    const url = `ws://${host}:${port}/${timestamp}/${streamType}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => {
      // Identify ourselves then authenticate
      this.send(`SERVER DE CLIENT open-sigint.js ${streamType}`);
      this.sendAuth(password);
      if (username) this.send(`SET ident_user=${username}`);
      this.onOpen();
      this.keepaliveTimer = setInterval(() => this.send('SET keepalive'), KEEPALIVE_INTERVAL_MS) as unknown as number;
      this.emit('open');
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      let buf: Uint8Array;
      if (typeof event.data === 'string') {
        buf = new TextEncoder().encode(event.data);
      } else {
        buf = new Uint8Array(event.data as ArrayBuffer);
      }
      if (buf.length < 3) return;

      const tag = ascii.decode(buf.subarray(0, 3));
      const body = buf.subarray(3);

      if (tag === 'MSG') {
        const params = parseMsgBody(utf8.decode(body));
        this.onMsg(params);
        this.emit('msg', params);
      } else {
        this.onBinary(tag, body);
      }
    });

    this.ws.addEventListener('error', (_event: Event) => {
      this.emit('error', new Error('WebSocket error'));
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      this.cleanup();
      this.emit('close', event.code, event.reason);
    });
  }

  protected send(msg: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    }
  }

  private sendAuth(password: string): void {
    this.send(`SET auth t=kiwi p=${password}`);
  }

  /** Called once after the WebSocket opens, before keepalive starts.
   *  Subclasses send their stream-specific SET commands here. */
  protected abstract onOpen(): void;

  /** Called for each parsed MSG frame. */
  protected abstract onMsg(params: Record<string, string>): void;

  /** Called for binary frames with a non-MSG tag. */
  protected abstract onBinary(tag: string, body: Uint8Array): void;

  private cleanup(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    this.ws.close();
  }
}
