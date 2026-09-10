import { startCloud } from './cloud-entry.mjs';

const app = await startCloud({
  port: 0,
  publicHost: 'localhost',
  id: 'RBC-0000032',
  pathSecret: 'build-smoke-secret-00000000',
  upstream: 'ws://127.0.0.1:9/RBC-0000032',
  authUser: 'smoke',
  authPassword: 'smoke',
  meterLogFile: null,
  routingFile: 'data/build-smoke-routing.json'
});
console.log(`Cloud-startcontrole geslaagd op testpoort ${app.port}`);
await app.close();
