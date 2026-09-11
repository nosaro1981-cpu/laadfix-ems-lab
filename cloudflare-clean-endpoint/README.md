# Clean OCPP ingress

This Worker exposes the intended charger URL:

`ws://ocpp.laadfix.nl/ocpp/<charge-point-id>`

It validates the OCPP 1.6 WebSocket upgrade, allow-lists known charge-point IDs,
and forwards the connection to the private Render relay path. The existing
workers.dev ingress can stay active while this hostname is prepared.

## Deployment

```powershell
npx wrangler deploy -c cloudflare-clean-endpoint/wrangler.jsonc
```

`GET /health` is a non-OCPP readiness probe. Do not change a charger endpoint
until this probe resolves through `ocpp.laadfix.nl` and a WebSocket test passes.

The current authoritative DNS provider is SiteGround. A CNAME for `ocpp` has
been prepared there, but Cloudflare must accept the hostname as an active custom
domain before traffic can use it. Keep the working charger endpoint in place
until that final DNS condition is met.
