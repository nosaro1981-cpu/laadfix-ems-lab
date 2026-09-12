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

    const requestedProtocols = (request.headers.get('Sec-WebSocket-Protocol') || '')
      .split(',').map(value => value.trim()).filter(Boolean);
    console.log(JSON.stringify({event:'ocpp_ingress',path:url.pathname,protocols:requestedProtocols,country:request.cf?.country||null,colo:request.cf?.colo||null}));

    // Return the upgraded origin response directly. Cloudflare then proxies
    // protocol ping/pong and close frames at the edge while Render still sees
    // every OCPP data frame for the dashboard and Robo Charge relay.
    try {
      const upstreamHeaders = new Headers({Upgrade:'websocket'});
      const protocolHeader = request.headers.get('Sec-WebSocket-Protocol');
      const authorization = request.headers.get('Authorization');
      if (protocolHeader) upstreamHeaders.set('Sec-WebSocket-Protocol', protocolHeader);
      if (authorization) upstreamHeaders.set('Authorization', authorization);
      const upstreamResponse = await fetch(RENDER_ORIGIN + url.pathname + url.search, {
        headers:upstreamHeaders,
      });
      console.log(JSON.stringify({event:upstreamResponse.webSocket?'backend_proxy_open':'backend_rejected',status:upstreamResponse.status}));
      return upstreamResponse;
    } catch (error) {
      console.log(JSON.stringify({event:'backend_error',message:String(error?.message||error)}));
      return new Response('OCPP-backend tijdelijk niet bereikbaar', {status:503});
    }
  },
};
