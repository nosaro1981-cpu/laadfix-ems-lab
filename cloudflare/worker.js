const EXPECTED_PATH = '/ocpp/lfx-ocpp-2026-RBC0000032-7Qm9Xp4Vt8Ks/RBC-0000032';
const RENDER_ORIGIN = 'https://laadfix-ems-lab.onrender.com';
const BACKEND_STALE_MS = 150_000;

export class OcppGateway {
  constructor(ctx) {
    this.ctx = ctx;
    this.activeCharger = null;
    this.backend = null;
    this.backendPromise = null;
    this.queue = [];
    this.backendOpenedAt = 0;
    this.lastBackendMessageAt = 0;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const charger = pair[1];
    const url = new URL(request.url);
    charger.serializeAttachment({path:url.pathname + url.search});
    // Keep the charger connected at the edge while Render is replaced. The
    // backend leg is reopened independently when it becomes stale or closes.
    this.ctx.acceptWebSocket(charger, ['charger']);
    const requested = (request.headers.get('Sec-WebSocket-Protocol') || '')
      .split(',').map(value => value.trim()).filter(Boolean);
    const selected = requested.find(value => /^ocpp1\.6j?$/i.test(value));
    const headers = new Headers();
    if (selected) headers.set('Sec-WebSocket-Protocol', selected);
    headers.set('Report-To','');
    headers.set('NEL','');
    headers.set('Alt-Svc','');
    return new Response(null, {status:101, webSocket:client, headers});
  }

  async openBackend(path) {
    if (this.backend?.readyState === WebSocket.OPEN) return this.backend;
    if (this.backendPromise) return this.backendPromise;
    this.backendPromise = (async()=>{
      const response = await fetch(RENDER_ORIGIN + path, {
        headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'ocpp1.6'},
      });
      if (!response.webSocket) throw new Error(`Render weigerde WebSocket: ${response.status}`);
      const backend = response.webSocket;
      backend.accept();
      this.backend = backend;
      this.backendOpenedAt = Date.now();
      this.lastBackendMessageAt = Date.now();
      backend.addEventListener('message', event => {
        if (this.backend !== backend) return;
        this.lastBackendMessageAt = Date.now();
        if (this.activeCharger?.readyState === WebSocket.OPEN) this.activeCharger.send(event.data);
      });
      const detach = (event, kind) => {
        if (this.backend !== backend) return;
        this.backend = null;
        this.backendOpenedAt = 0;
        this.lastBackendMessageAt = 0;
        console.log(JSON.stringify({event:kind,code:event?.code||null,reason:event?.reason||null}));
      };
      backend.addEventListener('close', event => detach(event, 'backend_closed'));
      backend.addEventListener('error', event => detach(event, 'backend_error'));
      for (const message of this.queue.splice(0)) backend.send(message);
      console.log(JSON.stringify({event:'backend_open',status:response.status}));
      return backend;
    })();
    try { return await this.backendPromise; }
    finally { this.backendPromise = null; }
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment() || {};
    if (this.activeCharger && this.activeCharger !== ws) {
      ws.close(1000, 'Andere verbinding actief');
      return;
    }
    if (!this.activeCharger) {
      this.activeCharger = ws;
      for (const candidate of this.ctx.getWebSockets('charger')) {
        if (candidate !== ws) candidate.close(1000, 'Andere verbinding gekozen');
      }
    }
    const backendSilentFor = Date.now() - Math.max(this.lastBackendMessageAt, this.backendOpenedAt);
    if (this.backend?.readyState === WebSocket.OPEN && backendSilentFor <= BACKEND_STALE_MS) {
      this.backend.send(message);
      return;
    }
    if (this.backend) {
      try { this.backend.close(1012, 'Backendverbinding vernieuwen'); } catch {}
      this.backend = null;
      this.backendOpenedAt = 0;
      this.lastBackendMessageAt = 0;
      console.log(JSON.stringify({event:'backend_stale',silentMs:backendSilentFor}));
    }
    if (this.queue.length >= 50) {
      this.closeActive(1011, 'Wachtrij vol');
      return;
    }
    this.queue.push(message);
    try {
      await this.openBackend(attachment.path || EXPECTED_PATH);
    } catch (error) {
      console.log(JSON.stringify({event:'backend_error',message:String(error?.message||error)}));
      this.backend = null;
    }
  }

  webSocketClose(ws, code, reason) {
    if (ws === this.activeCharger) {
      this.activeCharger = null;
      try { this.backend?.close(code || 1000, reason || 'Laadstation gesloten'); } catch {}
      this.backend = null;
      this.queue = [];
    }
  }

  webSocketError(ws) {
    if (ws === this.activeCharger) this.closeActive(1011, 'Laadstationfout');
  }

  closeActive(code, reason) {
    try { this.activeCharger?.close(code, reason); } catch {}
    try { this.backend?.close(code, reason); } catch {}
    this.activeCharger = null;
    this.backend = null;
    this.queue = [];
  }
}

export default {
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(fetch(RENDER_ORIGIN + '/healthz', {
      headers:{'User-Agent':'LaadFix-OCPP-healthcheck'},
      cf:{cacheTtl:0,cacheEverything:false},
    }).then(response => console.log(JSON.stringify({event:'backend_health',status:response.status})))
      .catch(error => console.log(JSON.stringify({event:'backend_health_error',message:String(error?.message||error)}))));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || url.pathname !== EXPECTED_PATH) {
      return new Response('OCPP WebSocket vereist', {status:403});
    }
    const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '')
      .split(',').map(value => value.trim()).filter(Boolean);
    console.log(JSON.stringify({event:'ocpp_ingress',path:url.pathname,protocols,country:request.cf?.country||null,colo:request.cf?.colo||null}));
    const id = env.OCPP_GATEWAY.idFromName(url.pathname);
    return env.OCPP_GATEWAY.get(id).fetch(request);
  },
};
