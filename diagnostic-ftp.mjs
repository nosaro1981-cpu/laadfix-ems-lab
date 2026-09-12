import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { Client } from 'basic-ftp';

export async function diagnosticLocation(configured, variant = 'default', resolve = lookup) {
  if (!['default', 'ipv4', 'ipv4-raw', 'hostname-raw'].includes(variant)) throw Error('Onbekende FTP-testvariant');
  if (variant === 'default') return configured;
  const url = new URL(configured);
  if (!['ftp:', 'ftps:'].includes(url.protocol)) throw Error('FTP is niet ingesteld');
  const host = variant.startsWith('ipv4') ? (await resolve(url.hostname, { family: 4 })).address : url.hostname;
  const user = variant.endsWith('-raw') ? decodeURIComponent(url.username) : url.username;
  const password = variant.endsWith('-raw') ? decodeURIComponent(url.password) : url.password;
  const location = `${url.protocol}//${user}:${password}@${host}:${url.port || 21}${url.pathname === '/' ? '' : url.pathname}`;
  if (variant.endsWith('-raw')) {
    let parsed;
    try { parsed = new URL(location); } catch { throw Error('Deze inloggegevens kunnen niet ongecodeerd in een FTP-adres'); }
    if (parsed.hostname !== host || decodeURIComponent(parsed.username) !== decodeURIComponent(url.username) || decodeURIComponent(parsed.password) !== password) {
      throw Error('Ongecodeerde FTP-notatie zou het account of de bestemming veranderen');
    }
  }
  return location;
}

export async function testDiagnosticFtp(configured, createClient = () => new Client(15000)) {
  if (!configured) throw Error('Er is geen diagnose-FTP ingesteld');
  const url = new URL(configured), client = createClient(), steps = [];
  const directory = decodeURIComponent(url.pathname || '/').replace(/\/$/, '') || '/';
  const name = `.laadfix-ftp-check-${randomUUID()}.txt`, path = (directory === '/' ? '' : directory) + '/' + name;
  let created = false;
  const clean = error => String(error.message || error).replaceAll(configured, '[FTP]').replaceAll(decodeURIComponent(url.password), '[afgeschermd]');
  try {
    await client.access({ host: url.hostname, port: Number(url.port || 21), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), secure: url.protocol === 'ftps:' });
    steps.push('Inloggen geslaagd');
    const entries = await client.list(directory);
    steps.push('Map uitlezen geslaagd');
    const content = Buffer.from('LaadFix FTP ontvangstcontrole\n');
    created = true;
    await client.uploadFrom(Readable.from([content]), path);
    steps.push('Testbestand uploaden geslaagd');
    const chunks = [];
    await client.downloadTo(new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } }), path);
    if (!Buffer.concat(chunks).equals(content)) throw Error('Teruggelezen testbestand wijkt af');
    steps.push('Testbestand teruglezen geslaagd');
    await client.remove(path); created = false; steps.push('Testbestand opgeruimd');
    return { ok: true, host: url.hostname, directory, steps, files: entries.filter(e => /diag|\.xls$/i.test(e.name)).map(e => ({ name: e.name, bytes: e.size, directory: e.isDirectory })) };
  } catch (error) { return { ok: false, host: url.hostname, directory, steps, error: clean(error) }; }
  finally { if (created) try { await client.remove(path); } catch {} client.close(); }
}
