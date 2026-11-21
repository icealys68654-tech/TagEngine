import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
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

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 50 * 1024 * 1024) {
        reject(new Error('Payload exceeds 50MB limit'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
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
  const url = req.url || '/';

  if (req.method === 'GET' && url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ONLINE',
        service: 'Entec OS Snapshot IDS Vector Engine',
        repository: 'https://github.com/icealys68654-tech/Entec.git',
      })
    );
    return;
  }

  if (req.method === 'POST' && url === '/api/analyze') {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entec-web-'));
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

      const t0Txt = path.join(tmpDir, 't0.txt');
      const t0Jsonl = path.join(tmpDir, 't0.jsonl');
      fs.writeFileSync(t0Txt, baselineText, 'utf8');

      if (!targetText.trim()) {
        // Single-snapshot vector parse & triage mode
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
        res.end(
          JSON.stringify({
            mode: 'SINGLE_PARSE',
            ...parseMeta,
            recordsReturned: triaged.length,
            records: triaged,
          })
        );
        return;
      }

      // Two-snapshot diff mode (shared anchor timestamp for deterministic drift)
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
      res.end(
        JSON.stringify({
          mode: 'SNAPSHOT_DIFF',
          sharedAnchorIso: new Date(sharedAnchor).toISOString(),
          baseline: parseT0,
          target: parseT1,
          summary: diffSummary,
          alerts,
        })
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
  }

  // Static website production file server
  const safePath = url === '/' ? 'index.html' : url.replace(/^\/+/, '').split('?')[0];
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

server.listen(PORT, () => {
  console.log(`[ENTEC-IDS] Server listening on http://localhost:${PORT}`);
});
