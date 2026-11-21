import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { timingSafeEqual } from 'crypto';
import { SnapshotStore } from './snapshot-store';
import {
  parseDirSnapshotToVectors,
  detectSnapshotAnchorEpoch,
  SnapshotManifestVector,
} from './snapshot-manifest-parser';
import {
  compareSnapshotVectorsDiskBacked,
  calculateSeverity,
  SnapshotDiffAlert,
} from './sqlite-snapshot-diff-comparator';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const API_TOKEN = process.env.ENTEC_API_TOKEN || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SNAPSHOT_DIR = path.resolve(process.env.ENTEC_SNAPSHOT_DIR || path.join(process.cwd(), 'data', 'snapshots'));
const snapshotStore = new SnapshotStore(SNAPSHOT_DIR);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '127.0.0.1' ||
    address.startsWith('::ffff:127.');
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!API_TOKEN) {
    // Local-only convenience for development. Production fails closed below.
    return !IS_PRODUCTION && isLoopback(req.socket.remoteAddress);
  }

  const authorization = req.headers.authorization || '';
  const match = /^Bearer (.+)$/i.exec(authorization);
  if (!match) return false;

  const supplied = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(API_TOKEN, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > 50 * 1024 * 1024) {
        settled = true;
        reject(new Error('Payload exceeds 50MB limit'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('JSON payload must be an object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

async function readJsonlRecords<T>(filePath: string, limit: number = 1000): Promise<T[]> {
  const results: T[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    results.push(JSON.parse(line));
    if (results.length >= limit) break;
  }
  return results;
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ONLINE',
      service: 'Entec OS Snapshot IDS Vector Engine',
      repository: 'https://github.com/icealys68654-tech/Entec.git',
    }));
    return;
  }

  if (url === '/api/snapshots' && (req.method === 'GET' || req.method === 'POST')) {
    if (IS_PRODUCTION && !API_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API authentication is not configured' }));
      return;
    }
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="TagEngine API"', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Bearer token required' }));
      return;
    }
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url || '/', 'http://localhost').searchParams;
        const volumeId = query.get('volumeId') || undefined;
        const limitValue = Number(query.get('limit') || '100');
        if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 500) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'limit must be an integer from 1 to 500' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ snapshots: snapshotStore.list(volumeId, limitValue) }));
        return;
      }
      const body = await readJsonBody(req);
      if (typeof body.snapshotText !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'snapshotText is required' }));
        return;
      }
      const snapshot = await snapshotStore.create({
        snapshotText: body.snapshotText,
        volumeId: typeof body.volumeId === 'string' ? body.volumeId : undefined,
        label: typeof body.label === 'string' ? body.label : undefined,
      });
      res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ snapshot }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Snapshot storage failed';
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  const snapshotMatch = req.method === 'GET' && url.match(/^\\/api\\/snapshots\\/([0-9a-f-]{36})$/i);
  if (snapshotMatch) {
    if (IS_PRODUCTION && !API_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API authentication is not configured' }));
      return;
    }
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="TagEngine API"', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Bearer token required' }));
      return;
    }
    const snapshot = snapshotStore.get(snapshotMatch[1]);
    if (!snapshot) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Snapshot not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ snapshot }));
    return;
  }

  if (req.method === 'POST' && url === '/api/analyze') {
    if (IS_PRODUCTION && !API_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API authentication is not configured' }));
      return;
    }
    if (!isAuthorized(req)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="TagEngine API"',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Bearer token required' }));
      return;
    }

    let tmpDir: string | undefined;
    try {
      const body = await readJsonBody(req);
      const baselineText = typeof body.baselineText === 'string' ? body.baselineText : '';
      const targetText = typeof body.targetText === 'string' ? body.targetText : '';
      const minSeverity = typeof body.minSeverity === 'number' ? body.minSeverity : 1.0;

      if (!baselineText.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'baselineText is required' }));
        return;
      }
      if (!Number.isFinite(minSeverity) || minSeverity < 0 || minSeverity > 10) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'minSeverity must be between 0 and 10' }));
        return;
      }

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entec-web-'));
      const t0Txt = path.join(tmpDir, 't0.txt');
      const t0Jsonl = path.join(tmpDir, 't0.jsonl');
      fs.writeFileSync(t0Txt, baselineText, 'utf8');

      if (!targetText.trim()) {
        const parseMeta = await parseDirSnapshotToVectors(t0Txt, t0Jsonl);
        const allVectors = await readJsonlRecords<SnapshotManifestVector>(t0Jsonl, 2000);
        const triaged = allVectors
          .map((rec) => {
            const dist = Math.sqrt(rec.vector.reduce((acc, v) => acc + v * v, 0));
            const severity = calculateSeverity('ADDED', rec.vector, dist, []);
            return { ...rec, severityScore: severity };
          })
          .filter((r) => r.severityScore >= minSeverity)
          .sort((a, b) => b.severityScore - a.severityScore);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          mode: 'SINGLE_PARSE',
          ...parseMeta,
          recordsReturned: triaged.length,
          records: triaged,
        }));
        return;
      }

      const t1Txt = path.join(tmpDir, 't1.txt');
      const t1Jsonl = path.join(tmpDir, 't1.jsonl');
      const diffJsonl = path.join(tmpDir, 'diff.jsonl');
      fs.writeFileSync(t1Txt, targetText, 'utf8');

      const anchor0 = await detectSnapshotAnchorEpoch(t0Txt);
      const anchor1 = await detectSnapshotAnchorEpoch(t1Txt);
      const sharedAnchor = Math.max(anchor0, anchor1);

      const parseT0 = await parseDirSnapshotToVectors(t0Txt, t0Jsonl, sharedAnchor);
      const parseT1 = await parseDirSnapshotToVectors(t1Txt, t1Jsonl, sharedAnchor);
      const diffSummary = await compareSnapshotVectorsDiskBacked(
        t0Jsonl,
        t1Jsonl,
        diffJsonl,
        minSeverity
      );
      const alerts = await readJsonlRecords<SnapshotDiffAlert>(diffJsonl, 2000);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        mode: 'SNAPSHOT_DIFF',
        sharedAnchorIso: new Date(sharedAnchor).toISOString(),
        baseline: parseT0,
        target: parseT1,
        summary: diffSummary,
        alerts,
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
  }

  const safePath = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

if (IS_PRODUCTION && !API_TOKEN) {
  console.error('[ENTEC-IDS] ENTEC_API_TOKEN is required in production; /api/analyze will return 503.');
}
if (!API_TOKEN && !IS_PRODUCTION) {
  console.warn('[ENTEC-IDS] No ENTEC_API_TOKEN set; /api/analyze is restricted to loopback clients.');
}

server.listen(PORT, () => {
  console.log(`[ENTEC-IDS] Server listening on http://localhost:${PORT}`);
});
