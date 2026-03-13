export class EventEmitter {
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
