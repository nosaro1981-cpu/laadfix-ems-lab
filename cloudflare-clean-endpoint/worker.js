/** Short OCPP ingress. Kept separate from the live workers.dev bridge. */
const RENDER_ORIGIN = 'https://laadfix-ems-lab.onrender.com';
const INTERNAL_PATH_SECRET = 'lfx-ocpp-2026-RBC0000032-7Qm9Xp4Vt8Ks';
const ALLOWED_CHARGERS = new Set(['RBC-0000032']);

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'LaadFix OCPP ingress' });
    }

    const parts = url.pathname.split('/').filter(Boolean);
    let chargerId = '';
    try { chargerId = decodeURIComponent(parts[1] || ''); } catch {}
    const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '')
      .split(',').map(value => value.trim());
    const valid = request.headers.get('Upgrade')?.toLowerCase() === 'websocket' &&
      parts.length === 2 && parts[0] === 'ocpp' && ALLOWED_CHARGERS.has(chargerId) &&
      protocols.includes('ocpp1.6');
    if (!valid) return new Response('OCPP WebSocket vereist', { status: 403 });

    const internalPath = `/ocpp/${encodeURIComponent(INTERNAL_PATH_SECRET)}/${encodeURIComponent(chargerId)}`;
    const pair = new WebSocketPair();
    const client = pair[0];
    const charger = pair[1];
    charger.accept();
    const queued = [];
    let backend = null;
    let closed = false;
    const closeBoth = (code = 1011, reason = 'Proxyverbinding gesloten') => {
      if (closed) return;
      closed = true;
      try { charger.close(code, reason); } catch {}
      try { backend?.close(code, reason); } catch {}
    };
    charger.addEventListener('message', event => {
      if (backend?.readyState === 1) backend.send(event.data);
      else if (queued.length < 20) queued.push(event.data);
      else closeBoth(1011, 'Wachtrij vol');
    });
    charger.addEventListener('close', () => closeBoth(1000, 'Laadstation gesloten'));
    charger.addEventListener('error', () => closeBoth());
    ctx.waitUntil((async () => {
      try {
        const headers = new Headers({
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': 'ocpp1.6'
        });
        const authorization = request.headers.get('Authorization');
        if (authorization) headers.set('Authorization', authorization);
        const response = await fetch(RENDER_ORIGIN + internalPath, { headers });
        backend = response.webSocket;
        if (!backend) throw new Error(`Render weigerde WebSocket: ${response.status}`);
        backend.accept();
        backend.addEventListener('message', event => charger.send(event.data));
        backend.addEventListener('close', () => closeBoth(1011, 'Backend gesloten'));
        backend.addEventListener('error', () => closeBoth());
        for (const message of queued.splice(0)) backend.send(message);
      } catch {
        closeBoth();
      }
    })());
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        'Sec-WebSocket-Protocol': 'ocpp1.6',
        'Report-To': '',
        NEL: '',
        'Alt-Svc': 'clear',
        Date: '',
        Server: '',
        'CF-Ray': ''
      }
    });
  }
};
