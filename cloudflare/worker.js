const OCPP_PATH_PREFIX = '/ocpp/lfx-ocpp-2026-RBC0000032-7Qm9Xp4Vt8Ks/';
const PRIMARY_CHARGER_ID = 'RBC-0000032';
const PRIMARY_PATH = OCPP_PATH_PREFIX + PRIMARY_CHARGER_ID;
const RENDER_ORIGIN = 'https://laadfix-ems-lab.onrender.com';
const BACKEND_STALE_MS = 150_000;
const BACKEND_RETRY_MIN_MS = 1_000;
const BACKEND_RETRY_MAX_MS = 10_000;
const BACKEND_WATCHDOG_MS = 30_000;

export class OcppGateway {
  constructor(ctx) {
    this.ctx = ctx;
    // Some Ecotap firmware sends a text keepalive in addition to WebSocket
    // control-frame pings. Answer it at Cloudflare's edge, even while this
    // Durable Object is hibernating, so a slow/restarting backend can never
    // cause the charger to report WS PONG TIMEOUT.
    if (typeof WebSocketRequestResponsePair !== 'undefined' && typeof ctx.setWebSocketAutoResponse === 'function') {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
    this.activeCharger = null;
    this.backend = null;
    this.backendPromise = null;
    this.queue = [];
    this.backendOpenedAt = 0;
    this.lastBackendMessageAt = 0;
    this.backendRetryAttempt = 0;
  }

  connectedCharger() {
    if (this.activeCharger?.readyState === WebSocket.OPEN) return this.activeCharger;
    this.activeCharger = this.ctx.getWebSockets('charger').find(socket => socket.readyState === WebSocket.OPEN) || null;
    return this.activeCharger;
  }

  async scheduleBackendReconnect(delay = BACKEND_RETRY_MIN_MS) {
    if (!this.connectedCharger() || this.backend?.readyState === WebSocket.OPEN) return;
    await this.ctx.storage.setAlarm(Date.now() + Math.max(BACKEND_RETRY_MIN_MS, delay));
  }

  async backendHealthy() {
    try {
      const response = await fetch(RENDER_ORIGIN + '/healthz', {cf:{cacheTtl:0,cacheEverything:false}});
      return response.ok;
    } catch {
      return false;
    }
  }

  async alarm() {
    const charger = this.connectedCharger();
    if (!charger) return;
    const attachment = charger.deserializeAttachment() || {};
    try {
      if (this.backend?.readyState === WebSocket.OPEN) {
        if (await this.backendHealthy()) {
          await this.ctx.storage.setAlarm(Date.now() + BACKEND_WATCHDOG_MS);
          return;
        }
        try { this.backend.close(1012, 'Render tijdelijk niet bereikbaar'); } catch {}
        this.backend = null;
      }
      await this.openBackend(attachment.path || PRIMARY_PATH);
      this.backendRetryAttempt = 0;
    } catch (error) {
      this.backendRetryAttempt += 1;
      const delay = Math.min(BACKEND_RETRY_MAX_MS, BACKEND_RETRY_MIN_MS * 2 ** Math.min(4, this.backendRetryAttempt));
      console.log(JSON.stringify({event:'backend_retry',attempt:this.backendRetryAttempt,delay,message:String(error?.message||error)}));
      await this.scheduleBackendReconnect(delay);
    }
  }

  async fetch(request) {
    if (new URL(request.url).pathname === '/_wake') {
      const charger = this.connectedCharger();
      if (charger) await this.scheduleBackendReconnect();
      return Response.json({ok:true,chargerConnected:!!charger,backendConnected:this.backend?.readyState===WebSocket.OPEN});
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const charger = pair[1];
    const url = new URL(request.url);
    charger.serializeAttachment({path:url.pathname + url.search,connectedAt:Date.now(),lastMessageAt:0});
    // Keep the charger connected at the edge while Render is replaced. The
    // backend leg is reopened independently when it becomes stale or closes.
    this.ctx.acceptWebSocket(charger, ['charger']);
    console.log(JSON.stringify({event:'charger_socket_accepted',path:url.pathname,existing:this.ctx.getWebSockets('charger').length}));
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
        const charger = this.connectedCharger();
        if (charger?.readyState === WebSocket.OPEN) charger.send(event.data);
      });
      const detach = (event, kind) => {
        if (this.backend !== backend) return;
        this.backend = null;
        this.backendOpenedAt = 0;
        this.lastBackendMessageAt = 0;
        console.log(JSON.stringify({event:kind,code:event?.code||null,reason:event?.reason||null}));
        this.ctx.waitUntil(this.scheduleBackendReconnect());
      };
      backend.addEventListener('close', event => detach(event, 'backend_closed'));
      backend.addEventListener('error', event => detach(event, 'backend_error'));
      await this.flushBackendQueue(backend);
      this.backendRetryAttempt = 0;
      this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + BACKEND_WATCHDOG_MS));
      console.log(JSON.stringify({event:'backend_open',status:response.status}));
      return backend;
    })();
    try { return await this.backendPromise; }
    finally { this.backendPromise = null; }
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment() || {};
    ws.serializeAttachment?.({...attachment,lastMessageAt:Date.now()});
    if (this.isBootNotification(message)) {
      const boot=typeof message==='string'?message:new TextDecoder().decode(message);
      this.ctx.waitUntil(this.ctx.storage.put('lastBootMessage',boot));
    }
    if (this.activeCharger !== ws) {
      const previous=this.activeCharger;
      this.activeCharger=ws;
      if (previous?.readyState===WebSocket.OPEN) {
        console.log(JSON.stringify({event:'charger_session_replaced'}));
        previous.close(1012,'Nieuwe ladersessie actief');
      }
      for (const candidate of this.ctx.getWebSockets('charger')) {
        if (candidate !== ws && candidate !== previous) candidate.close(1012,'Nieuwe ladersessie actief');
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
      await this.openBackend(attachment.path || PRIMARY_PATH);
    } catch (error) {
      console.log(JSON.stringify({event:'backend_error',message:String(error?.message||error)}));
      this.backend = null;
      this.ctx.waitUntil(this.scheduleBackendReconnect());
    }
  }

  isBootNotification(message) {
    try {
      const text=typeof message==='string'?message:new TextDecoder().decode(message);
      const frame=JSON.parse(text);
      return Array.isArray(frame)&&frame[0]===2&&frame[2]==='BootNotification';
    } catch { return false; }
  }

  async flushBackendQueue(backend) {
    const queued=this.queue.splice(0);
    if (!queued.some(message=>this.isBootNotification(message))) {
      const cachedBoot=await this.ctx.storage.get('lastBootMessage');
      if (cachedBoot) {
        backend.send(cachedBoot);
        console.log(JSON.stringify({event:'boot_replayed'}));
      }
    }
    for (const message of queued) backend.send(message);
  }

  webSocketClose(ws, code, reason) {
    console.log(JSON.stringify({event:'charger_closed',active:ws===this.activeCharger,code:code||null,reason:reason||null,remaining:this.ctx.getWebSockets('charger').length}));
    // Complete the close handshake explicitly as well. This is harmless on
    // newer compatibility dates and prevents an otherwise clean close being
    // reported to the other relay leg as code 1006 on older runtimes.
    try { ws.close(code, reason); } catch {}
    if (ws === this.activeCharger) {
      this.activeCharger = null;
      const closeCode = Number(code) >= 1000 && Number(code) <= 4999 && ![1005,1006,1015].includes(Number(code)) ? Number(code) : 1012;
      try { this.backend?.close(closeCode, reason || 'Laadstationverbinding verbroken'); } catch {}
      this.backend = null;
      this.queue = [];
      this.ctx.waitUntil(this.ctx.storage.deleteAlarm());
    }
  }

  webSocketError(ws) {
    console.log(JSON.stringify({event:'charger_error',active:ws===this.activeCharger,remaining:this.ctx.getWebSockets('charger').length}));
    if (ws === this.activeCharger) this.closeActive(1011, 'Laadstationfout');
  }

  closeActive(code, reason) {
    try { this.activeCharger?.close(code, reason); } catch {}
    try { this.backend?.close(code, reason); } catch {}
    this.activeCharger = null;
    this.backend = null;
    this.queue = [];
    this.ctx.waitUntil(this.ctx.storage.deleteAlarm());
  }
}

export default {
  async scheduled(_controller, env, ctx) {
    const gateway = env.OCPP_GATEWAY.get(env.OCPP_GATEWAY.idFromName(PRIMARY_PATH));
    ctx.waitUntil(Promise.all([fetch(RENDER_ORIGIN + '/healthz', {
      headers:{'User-Agent':'LaadFix-OCPP-healthcheck'},
      cf:{cacheTtl:0,cacheEverything:false},
    }).then(response => console.log(JSON.stringify({event:'backend_health',status:response.status})))
      .catch(error => console.log(JSON.stringify({event:'backend_health_error',message:String(error?.message||error)}))),
      gateway.fetch('https://ocpp-gateway.internal/_wake')
        .then(response => response.json())
        .then(status => console.log(JSON.stringify({event:'gateway_wake',...status})))
        .catch(error => console.log(JSON.stringify({event:'gateway_wake_error',message:String(error?.message||error)})))
    ]));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      const requestedId = url.searchParams.get('station') || PRIMARY_CHARGER_ID;
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(requestedId)) {
        return Response.json({ok:false,error:'Ongeldig laadstation-ID'},{status:400});
      }
      const canonicalPath = OCPP_PATH_PREFIX + requestedId;
      const id = env.OCPP_GATEWAY.idFromName(canonicalPath);
      const response = await env.OCPP_GATEWAY.get(id).fetch('https://ocpp-gateway.internal/_wake');
      const status = await response.json();
      return Response.json({...status,station:requestedId});
    }
    const chargerId = parseChargerId(url.pathname);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || !chargerId) {
      return new Response('OCPP WebSocket vereist', {status:403});
    }
    const canonicalPath = OCPP_PATH_PREFIX + chargerId;
    const id = env.OCPP_GATEWAY.idFromName(canonicalPath);
    const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '')
      .split(',').map(value => value.trim()).filter(Boolean);
    console.log(JSON.stringify({event:'ocpp_ingress',path:url.pathname,protocols,country:request.cf?.country||null,colo:request.cf?.colo||null}));
    return env.OCPP_GATEWAY.get(id).fetch(request);
  },
};

export function parseChargerId(pathname) {
  if (!String(pathname).startsWith(OCPP_PATH_PREFIX)) return null;
  let chargerId = '';
  try { chargerId = decodeURIComponent(String(pathname).slice(OCPP_PATH_PREFIX.length)); } catch { return null; }
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(chargerId) ? chargerId : null;
}
