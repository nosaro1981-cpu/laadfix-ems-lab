const EXPECTED_PATH = '/ocpp/lfx-ocpp-2026-RBC0000032-7Qm9Xp4Vt8Ks/RBC-0000032';
const RENDER_ORIGIN = 'https://laadfix-ems-lab.onrender.com';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const protocols = request.headers.get('Sec-WebSocket-Protocol') || '';
    const valid = request.headers.get('Upgrade')?.toLowerCase() === 'websocket' &&
      url.pathname === EXPECTED_PATH &&
      protocols.split(',').map(value => value.trim()).includes('ocpp1.6');
    if (!valid) return new Response('OCPP WebSocket vereist', { status: 403 });
    const upstream = new URL(url.pathname + url.search, RENDER_ORIGIN);
    return fetch(upstream, request);
  },
};
