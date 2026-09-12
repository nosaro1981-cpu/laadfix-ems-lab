const EXPECTED_PATH = '/ocpp/lfx-ocpp-2026-RBC0000032-7Qm9Xp4Vt8Ks/RBC-0000032';
const RENDER_ORIGIN = 'https://laadfix-ems-lab.onrender.com';

export default {
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(fetch(RENDER_ORIGIN + '/healthz', {
      headers:{'User-Agent':'LaadFix-OCPP-healthcheck'},
      cf:{cacheTtl:0,cacheEverything:false},
    }).then(response => console.log(JSON.stringify({event:'backend_health',status:response.status})))
      .catch(error => console.log(JSON.stringify({event:'backend_health_error',message:String(error?.message||error)}))));
  },
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || url.pathname !== EXPECTED_PATH) {
      return new Response('OCPP WebSocket vereist', { status: 403 });
    }

    // Some Ecotap firmware uses OCPP 1.6J without advertising the optional
    // WebSocket subprotocol. Bridge that legacy handshake to strict OCPP 1.6.
    const requestedProtocols = (request.headers.get('Sec-WebSocket-Protocol') || '')
      .split(',').map(value => value.trim()).filter(Boolean);
    const selectedProtocol = requestedProtocols.find(value => /^ocpp1\.6j?$/i.test(value)) || null;
    console.log(JSON.stringify({event:'ocpp_ingress',path:url.pathname,protocols:requestedProtocols,country:request.cf?.country||null,colo:request.cf?.colo||null}));
    const upstreamHeaders = new Headers({Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ocpp1.6'});
    const authorization = request.headers.get('Authorization');
    if (authorization) upstreamHeaders.set('Authorization', authorization);
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(RENDER_ORIGIN + url.pathname + url.search, {headers:upstreamHeaders});
    } catch (error) {
      console.log(JSON.stringify({event:'backend_error',message:String(error?.message||error)}));
      return new Response('OCPP-backend tijdelijk niet bereikbaar', {status:503});
    }
    const backend = upstreamResponse.webSocket;
    if (!backend) {
      console.log(JSON.stringify({event:'backend_rejected',status:upstreamResponse.status}));
      return new Response('OCPP-backend weigerde WebSocket', {status:502});
    }
    backend.accept();
    console.log(JSON.stringify({event:'backend_open',status:upstreamResponse.status}));
    const pair = new WebSocketPair();
    const client = pair[0];
    const charger = pair[1];
    charger.accept();
    let closed = false;
    const closeBoth = (code = 1011, reason = 'Proxyverbinding gesloten') => {
      if (closed) return;
      closed = true;
      try { charger.close(code, reason); } catch {}
      try { backend?.close(code, reason); } catch {}
    };
    charger.addEventListener('message', event => {
      if (backend.readyState === 1) backend.send(event.data);
      else closeBoth(1011, 'Backend niet beschikbaar');
    });
    charger.addEventListener('close', event => {console.log(JSON.stringify({event:'charger_close',code:event.code,reason:event.reason||''}));closeBoth(event.code || 1000, 'Laadstation gesloten');});
    charger.addEventListener('error', () => closeBoth());
    backend.addEventListener('message', event => { if (!closed) charger.send(event.data); });
    backend.addEventListener('close', event => closeBoth(event.code || 1011, 'Backend gesloten'));
    backend.addEventListener('error', () => closeBoth());
    const headers = new Headers();
    if (selectedProtocol) headers.set('Sec-WebSocket-Protocol', selectedProtocol);
    return new Response(null, {status: 101, webSocket: client, headers});
  },
};
