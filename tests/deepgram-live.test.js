const test = require('node:test');
const assert = require('node:assert/strict');

const deepgramAdapter = require('../providers/adapters/deepgram.js');
const {
  KEEPALIVE_INTERVAL_MS,
  createDeepgramLiveTransport
} = require('../providers/live/deepgram-live.js');

class FakeWebSocket {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols = []) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.forEach((listener) => listener(event));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', { target: this });
  }

  send(payload) {
    this.sent.push(payload);
  }

  failHandshake(reason = 'handshake failed') {
    this.emit('error', { message: reason });
  }

  receiveJson(payload) {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  close(code = 1000, reason = 'closed', wasClean = true) {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code, reason, wasClean });
  }
}

function createTimerHarness() {
  const timers = [];
  return {
    timers,
    setIntervalImpl(callback, ms) {
      const timer = {
        callback,
        ms,
        cleared: false,
        unref() {}
      };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl(timer) {
      if (timer) {
        timer.cleared = true;
      }
    }
  };
}

test('Deepgram live transport parses partial and final Results events', async () => {
  FakeWebSocket.instances.length = 0;
  const messages = [];
  const transport = createDeepgramLiveTransport({
    settings: { apiKey: 'dg-key', liveEnabled: true, model: 'nova-3' },
    language: 'es',
    createWebSocket: (url, protocols) => new FakeWebSocket(url, protocols)
  });

  transport.onMessage((event) => {
    messages.push(event);
  });

  const connectPromise = transport.connect();
  const socket = FakeWebSocket.instances[0];
  assert.match(socket.url, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.match(socket.url, /token=dg-key/);
  assert.match(socket.url, /model=nova-3/);
  assert.match(socket.url, /language=es/);
  assert.match(socket.url, /encoding=opus/);
  assert.match(socket.url, /sample_rate=48000/);
  socket.open();
  await connectPromise;

  socket.receiveJson({
    type: 'Results',
    is_final: false,
    channel: { alternatives: [{ transcript: 'hola parci' }] }
  });
  socket.receiveJson({
    type: 'Results',
    is_final: true,
    channel: { alternatives: [{ transcript: 'hola parcial final' }] }
  });

  assert.deepEqual(messages.map((event) => ({ type: event.type, text: event.text, isFinal: event.isFinal })), [
    { type: 'partial', text: 'hola parci', isFinal: false },
    { type: 'final', text: 'hola parcial final', isFinal: true }
  ]);
});

test('Deepgram live transport sends keepalive frames on interval', async () => {
  FakeWebSocket.instances.length = 0;
  const timerHarness = createTimerHarness();
  const transport = createDeepgramLiveTransport({
    settings: { apiKey: 'dg-key', liveEnabled: true },
    createWebSocket: (url, protocols) => new FakeWebSocket(url, protocols),
    setIntervalImpl: timerHarness.setIntervalImpl,
    clearIntervalImpl: timerHarness.clearIntervalImpl
  });

  const connectPromise = transport.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connectPromise;

  assert.equal(timerHarness.timers.length, 1);
  assert.equal(timerHarness.timers[0].ms, KEEPALIVE_INTERVAL_MS);

  timerHarness.timers[0].callback();

  assert.deepEqual(socket.sent, ['{"type":"KeepAlive"}']);
});

test('Deepgram live transport closes cleanly with CloseStream before websocket close', async () => {
  FakeWebSocket.instances.length = 0;
  const closes = [];
  const transport = createDeepgramLiveTransport({
    settings: { apiKey: 'dg-key', liveEnabled: true },
    createWebSocket: (url, protocols) => new FakeWebSocket(url, protocols)
  });

  transport.onClose((event) => {
    closes.push(event.code);
  });

  const connectPromise = transport.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connectPromise;

  const closePromise = transport.close();
  assert.equal(socket.sent[0], '{"type":"CloseStream"}');
  await closePromise;

  assert.deepEqual(closes, [1000]);
});

test('Deepgram live transport surfaces warnings and provider errors', async () => {
  FakeWebSocket.instances.length = 0;
  const messages = [];
  const errors = [];
  const transport = createDeepgramLiveTransport({
    settings: { apiKey: 'dg-key', liveEnabled: true },
    createWebSocket: (url, protocols) => new FakeWebSocket(url, protocols)
  });

  transport.onMessage((event) => messages.push(event));
  transport.onError((error) => errors.push(error));

  const connectPromise = transport.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connectPromise;

  socket.receiveJson({ type: 'Warning', warning: 'latency', description: 'Slow upstream audio.' });
  socket.receiveJson({ type: 'Error', code: 'BadRequest', description: 'Unsupported media.' });

  assert.deepEqual(messages.map((event) => ({ type: event.type, code: event.code, message: event.message })), [
    { type: 'warning', code: 'latency', message: 'Slow upstream audio.' }
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fallbackReady, true);
  assert.equal(errors[0].code, 'BadRequest');
  assert.match(errors[0].message, /Unsupported media/i);
});

test('Deepgram live startup validation blocks disabled live rollout and missing key', async () => {
  assert.throws(
    () => deepgramAdapter.getDeepgramLiveConfig({ apiKey: 'dg-key', liveEnabled: false }),
    (error) => {
      assert.equal(error.code, 'live_disabled');
      assert.equal(error.fallbackReady, true);
      return true;
    }
  );

  assert.throws(
    () => deepgramAdapter.getDeepgramLiveConfig({ apiKey: '', liveEnabled: true }),
    (error) => {
      assert.equal(error.status, 422);
      return true;
    }
  );
});

test('Deepgram live handshake failure returns a fallback-ready error', async () => {
  FakeWebSocket.instances.length = 0;
  const errors = [];
  const transport = createDeepgramLiveTransport({
    settings: { apiKey: 'dg-key', liveEnabled: true },
    createWebSocket: (url, protocols) => new FakeWebSocket(url, protocols)
  });

  transport.onError((error) => errors.push(error));

  const connectPromise = transport.connect();
  const socket = FakeWebSocket.instances[0];
  socket.failHandshake('socket rejected');

  await assert.rejects(connectPromise, (error) => {
    assert.equal(error.code, 'handshake_failed');
    assert.equal(error.fallbackReady, true);
    assert.equal(error.retryable, true);
    return true;
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'handshake_failed');
});
