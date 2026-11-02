import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

// No dependencies; only expose files below the requested root on loopback.
const [rootArg = 'www', portArg = '8848'] = process.argv.slice(2);
const root = await realpath(path.resolve(rootArg));
const port = Number(portArg);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
function insideRoot(file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
const server = http.createServer(async (req, res) => {
  const reply = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); };
  if (!['GET', 'HEAD'].includes(req.method)) { reply(405, 'Method not allowed'); return; }
  try {
    const pathname = decodeURIComponent(req.url.split('?')[0]);
    const segments = pathname.split(/[\\/]+/).filter(Boolean);
    if (segments.some((part) => part.startsWith('.') || part.includes(':') || part.includes('\0')
      || /^(?:node_modules|private-backups|_out|build|keystore\.properties|local\.properties)$/i.test(part)
      || /\.(?:keystore|jks|p12|pfx|pem|key)$/i.test(part)
      || /^exercise-record-(?:backup|export).+\.(?:json|txt)$/i.test(part))) {
      reply(403, 'Forbidden'); return;
    }
    let file = path.resolve(root, ...segments);
    if (!insideRoot(file)) { reply(403, 'Forbidden'); return; }
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    file = await realpath(file);
    if (!insideRoot(file)) { reply(403, 'Forbidden'); return; }
    if (!(await stat(file)).isFile()) { reply(404, 'Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    reply(error instanceof URIError ? 400 : 404, 'Not found');
  }
});
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Serving ${root} at http://127.0.0.1:${server.address().port}/`));
