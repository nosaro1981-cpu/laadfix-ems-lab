import { startCloud } from './cloud-entry.mjs';

const app = await startCloud();
console.log(`LaadFix online proxy draait op poort ${app.port}`);

const stop = async () => {
  await app.close();
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
