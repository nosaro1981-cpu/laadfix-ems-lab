const EXPECTED_PATH = '/ocpp/lfx-ocpp-2026-RBC0000032-7Qm9Xp4Vt8Ks/RBC-0000032';
const RENDER_ORIGIN = 'https://laadfix-ems-lab.onrender.com';

export class OcppGateway {
  constructor(ctx) {
    this.ctx = ctx;
    this.activeCharger = null;
    this.backend = null;
    this.backendPromise = null;
    this.queue = [];
    this.compatibilityTimers = new Map();
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const charger = pair[1];
    const url = new URL(request.url);
    charger.serializeAttachment({path:url.pathname + url.search,recoveryId:null});
    // Durable Objects answer WebSocket protocol ping frames at the edge. This
    // is required by older Ecotap firmware before it sends BootNotification.
    this.ctx.acceptWebSocket(charger, ['charger']);
    const timer = setTimeout(()=>{
      if (charger.readyState !== WebSocket.OPEN || this.activeCharger === charger) return;
      const attachment = charger.deserializeAttachment() || {};
      const recoveryId = `legacy-${crypto.randomUUID()}`;
      charger.serializeAttachment({...attachment,recoveryId});
      charger.send(JSON.stringify([2,recoveryId,'ChangeConfiguration',{key:'WebSocketPingInterval',value:'0'}]));
      console.log(JSON.stringify({event:'legacy_config_sent'}));
    },1500);
    this.compatibilityTimers.set(charger,timer);
    const requested = (request.headers.get('Sec-WebSocket-Protocol') || '')
      .split(',').map(value => value.trim()).filter(Boolean);
    const selected = requested.find(value => /^ocpp1\.6j?$/i.test(value));
    const headers = new Headers();
    if (selected) headers.set('Sec-WebSocket-Protocol', selected);
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
      backend.addEventListener('message', event => {
        if (this.activeCharger?.readyState === WebSocket.OPEN) this.activeCharger.send(event.data);
      });
      backend.addEventListener('close', event => this.closeActive(event.code || 1011, event.reason || 'Backend gesloten'));
      backend.addEventListener('error', () => this.closeActive(1011, 'Backendfout'));
      for (const message of this.queue.splice(0)) backend.send(message);
      console.log(JSON.stringify({event:'backend_open',status:response.status}));
      return backend;
    })();
    try { return await this.backendPromise; }
    finally { this.backendPromise = null; }
  }

  async webSocketMessage(ws, message) {
    const timer = this.compatibilityTimers.get(ws);
    if (timer) clearTimeout(timer);
    this.compatibilityTimers.delete(ws);
    const attachment = ws.deserializeAttachment() || {};
    if (typeof message === 'string' && attachment.recoveryId) {
      try {
        const frame = JSON.parse(message);
        if (Array.isArray(frame) && [3,4].includes(frame[0]) && frame[1] === attachment.recoveryId) {
          const accepted = frame[0] === 3 && frame[2]?.status === 'Accepted';
          console.log(JSON.stringify({event:accepted?'legacy_config_accepted':'legacy_config_rejected'}));
          if (accepted) ws.close(1012,'Pingcompatibiliteit toegepast');
          return;
        }
      } catch {}
    }
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
    if (this.backend?.readyState === WebSocket.OPEN) {
      this.backend.send(message);
      return;
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
      this.closeActive(1011, 'OCPP-backend niet bereikbaar');
    }
  }

  webSocketClose(ws, code, reason) {
    const timer = this.compatibilityTimers.get(ws);
    if (timer) clearTimeout(timer);
    this.compatibilityTimers.delete(ws);
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
