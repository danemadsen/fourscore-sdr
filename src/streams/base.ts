import { parseMsgBody } from '../utils/msg';

const KEEPALIVE_INTERVAL_MS = 1000;

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
  protected ws: WebSocket | null = null;
  private keepaliveTimer: number | null = null;
  private closed = false;
  private streamStarted = false;

  /** Default trigger: fire once auth is confirmed (badp=0). Subclasses may override. */
  protected isStreamReady(params: Record<string, string>): boolean {
    return params['badp'] === '0';
  }

  constructor(
    protected readonly host: string,
    protected readonly port: number,
    streamType: 'SND' | 'W/F',
    password: string,
    username: string,
  ) {
    super();

    fetch(`http://${host}:${port}/VER`)
      .then(r => r.json() as Promise<{ ts: number }>)
      .then(ver => {
        if (this.closed) return;
        const url = `ws://${host}:${port}/ws/kiwi/${ver.ts}/${streamType}`;
        this._connect(url, streamType, password, username);
      })
      .catch(() => {
        // VER fetch failed — fall back to old-style URL with local timestamp
        if (this.closed) return;
        const ts = Math.floor(Date.now() / 1000);
        const url = `ws://${host}:${port}/${ts}/${streamType}`;
        this._connect(url, streamType, password, username);
      });
  }

  private _connect(url: string, streamType: string, password: string, username: string): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      this.send(`SERVER DE CLIENT openwebrx.js ${streamType}`);
      this.sendAuth(password);
      if (username) this.send(`SET ident_user=${username}`);
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

        if ('badp' in params && params['badp'] !== '0') {
          this.emit('error', new Error(`KiwiSDR rejected auth (badp=${params['badp']})`));
          return;
        }

        if (!this.streamStarted && this.isStreamReady(params)) {
          this.streamStarted = true;
          this.onOpen();
          this.send('SET keepalive');
          this.keepaliveTimer = setInterval(() => this.send('SET keepalive'), KEEPALIVE_INTERVAL_MS) as unknown as number;
          this.emit('open');
        }

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
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    }
  }

  private sendAuth(password: string): void {
    this.send(`SET auth t=kiwi p=${password}`);
  }

  /** Called once the stream is ready. Subclasses send their SET commands here. */
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
    this.ws?.close();
  }
}
