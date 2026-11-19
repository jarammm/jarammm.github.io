// WebSocket client to the show bridge. Fire-and-forget: a missing or dropped bridge
// must never affect playback, so every send is optional and reconnects run in the background.

const BACKOFF_MIN = 500;     // ms
const BACKOFF_MAX = 5000;    // ms
const MAX_BUFFERED = 64 * 1024; // drop feature frames rather than queueing stale ones

export class BridgeClient {
  /**
   * @param {string} url  ws:// or wss:// endpoint
   * @param {(state:"connecting"|"connected"|"error"|"off", detail?:string)=>void} onStatus
   */
  constructor(url, onStatus = () => {}) {
    this.url = url;
    this.onStatus = onStatus;
    this.ws = null;
    this.lastState = null;
    this.backoff = BACKOFF_MIN;
    this.closed = false;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    this.onStatus("connecting", this.url);
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.onStatus("error", e.message);
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = BACKOFF_MIN;
      this.onStatus("connected", this.url);
      // The bridge may have restarted; give it the current state immediately.
      if (this.lastState) this.raw(this.lastState);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.closed) {
        this.onStatus("error", "disconnected; retrying");
        this.retry();
      }
    };
    ws.onerror = () => {}; // onclose follows and handles retry
  }

  retry() {
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(BACKOFF_MAX, this.backoff * 2);
  }

  raw(msg) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Controller state; remembered so it can be replayed after a reconnect. */
  sendState(state) {
    this.lastState = { type: "state", ...state };
    this.raw(this.lastState);
  }

  /** High-rate audio features; dropped when the socket is backed up. */
  sendFeatures(features) {
    if (this.ws && this.ws.bufferedAmount > MAX_BUFFERED) return;
    this.raw({ type: "features", ...features });
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this.onStatus("off");
  }
}
