import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { parseMsgBody } from '../utils/msg';

const KEEPALIVE_INTERVAL_MS = 5000;

export abstract class BaseStream extends EventEmitter {
  protected ws: WebSocket;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
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

    this.ws.on('open', () => {
      // Identify ourselves then authenticate
      this.send(`SERVER DE CLIENT open-sigint.js ${streamType}`);
      this.sendAuth(password);
      if (username) this.send(`SET ident_user=${username}`);
      this.onOpen();
      this.keepaliveTimer = setInterval(() => this.send('SET keepalive'), KEEPALIVE_INTERVAL_MS);
      this.emit('open');
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length < 3) return;

      const tag = buf.subarray(0, 3).toString('ascii');
      const body = buf.subarray(3);

      if (tag === 'MSG') {
        const params = parseMsgBody(body.toString('utf8'));
        this.onMsg(params);
        this.emit('msg', params);
      } else {
        this.onBinary(tag, body);
      }
    });

    this.ws.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.cleanup();
      this.emit('close', code, reason.toString());
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
  protected abstract onBinary(tag: string, body: Buffer): void;

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
