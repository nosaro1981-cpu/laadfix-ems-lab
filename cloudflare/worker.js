const EXPECTED_PATH = '/ocpp/lfx-ocpp-2026-RBC0000032-7Qm9Xp4Vt8Ks/RBC-0000032';
const RENDER_ORIGIN = 'https://laadfix-ems-lab.onrender.com';
const MAX_QUEUED_MESSAGES = 64;
const MAX_QUEUED_BYTES = 512 * 1024;

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'LaadFix OCPP gateway' });
    }

    const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '')
      .split(',').map(value => value.trim());
    const valid = request.headers.get('Upgrade')?.toLowerCase() === 'websocket' &&
      url.pathname === EXPECTED_PATH && protocols.includes('ocpp1.6');
    if (!valid) return new Response('OCPP WebSocket vereist', { status: 403 });

    // Accept the Homebox immediately. Render free instances can need roughly
    // 50 seconds to wake; making the controller wait for that HTTP upgrade can
    // trigger its multi-minute reconnect backoff.
    const pair = new WebSocketPair();
    const client = pair[0];
    const charger = pair[1];
    charger.accept();

    const queued = [];
    let queuedBytes = 0;
    let backend = null;
    let closed = false;

    const closeBoth = (code = 1011, reason = 'Proxyverbinding gesloten') => {
      if (closed) return;
      closed = true;
      try { charger.close(code, reason); } catch {}
      try { backend?.close(code, reason); } catch {}
    };
    const queue = data => {
      const size = typeof data === 'string' ? data.length : data?.byteLength || 0;
      if (queued.length >= MAX_QUEUED_MESSAGES || queuedBytes + size > MAX_QUEUED_BYTES) {
        closeBoth(1011, 'Wachtrij vol');
        return;
      }
      queued.push(data);
      queuedBytes += size;
    };

    charger.addEventListener('message', event => {
      if (backend?.readyState === 1) backend.send(event.data);
      else queue(event.data);
    });
    charger.addEventListener('close', () => closeBoth(1000, 'Laadstation gesloten'));
    charger.addEventListener('error', () => closeBoth());

    ctx.waitUntil((async () => {
      const delays = [0, 500, 1000, 2000, 4000, 8000, 12000, 16000, 20000];
      for (const delay of delays) {
        if (closed) return;
        if (delay) await wait(delay);
        try {
          const headers = new Headers({
            Upgrade: 'websocket',
            'Sec-WebSocket-Protocol': 'ocpp1.6'
          });
          const authorization = request.headers.get('Authorization');
          if (authorization) headers.set('Authorization', authorization);
          const response = await fetch(RENDER_ORIGIN + url.pathname + url.search, { headers });
          const candidate = response.webSocket;
          if (!candidate) throw new Error(`Render weigerde WebSocket: ${response.status}`);
          backend = candidate;
          backend.accept();
          backend.addEventListener('message', event => {
            if (!closed) charger.send(event.data);
          });
          backend.addEventListener('close', () => closeBoth(1011, 'Proxyserver opnieuw verbinden'));
          backend.addEventListener('error', () => closeBoth());
          for (const message of queued.splice(0)) backend.send(message);
          queuedBytes = 0;
          return;
        } catch {
          backend = null;
        }
      }
      closeBoth(1013, 'Proxyserver start nog op');
    })());

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'ocpp1.6' }
    });
  }
};
