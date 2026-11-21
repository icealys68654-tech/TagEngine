import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import Database from 'better-sqlite3';
import { SnapshotManifestVector, VECTOR_DIMENSIONS } from './snapshot-manifest-parser';

export type DiffStatus = 'ADDED' | 'MODIFIED' | 'DELETED';

export interface SnapshotDiffAlert {
  status: DiffStatus;
  fullPath: string;
  pathHash: string;
  severityScore: number;
  euclideanDistance: number;
  cosineSimilarity: number;
  changedDimensions: string[];
  baseline?: SnapshotManifestVector['metadata'];
  target?: SnapshotManifestVector['metadata'];
}

export function computeEuclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export function computeCosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function calculateSeverity(
  status: DiffStatus,
  vec: number[],
  distance: number,
  changedDims: string[]
): number {
  let score = 0;

  // 0: isExecutable, 3: isRecycleBin, 4: isSystemOrProgramPath, 5: isHiddenOrDotPath, 6: isReparsePoint, 11: timestampSkewAnomaly
  if (vec[0] === 1) score += 3.0;
  if (vec[4] === 1) score += 2.5;
  if (vec[6] === 1) score += 2.5;
  if (vec[0] === 1 && vec[3] === 1) score += 2.0;
  if (vec[5] === 1) score += 1.0;
  if (vec[11] === 1) score += 1.5;

  if (status === 'ADDED') {
    score += 1.5;
  } else if (status === 'MODIFIED') {
    score += Math.min(distance * 3.0, 3.0);
    if (vec[0] === 1 && changedDims.includes('logSize')) {
      score += 2.0;
    }
  } else if (status === 'DELETED') {
    score = vec[0] === 1 || vec[4] === 1 ? score + 1.5 : score * 0.6;
  }

  return Number(Math.min(score, 10.0).toFixed(2));
}

/**
 * Compares multi-million-record snapshot JSONL files with constant RAM via SQLite.
 */
export async function compareSnapshotVectorsDiskBacked(
  baselineJsonlPath: string,
  targetJsonlPath: string,
  diffOutputJsonlPath: string,
  minSeverityThreshold: number = 2.0
): Promise<{
  added: number;
  modified: number;
  deleted: number;
  alertsEmitted: number;
}> {
  const tempDbPath = path.join(os.tmpdir(), `entec_ids_diff_${Date.now()}_${process.pid}.sqlite`);
  const db = new Database(tempDbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -32000');

  db.exec(`
    CREATE TABLE baseline (
      path_hash TEXT PRIMARY KEY,
      full_path TEXT NOT NULL,
      vector_blob BLOB NOT NULL,
      metadata_json TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
  `);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO baseline (path_hash, full_path, vector_blob, metadata_json, seen)
    VALUES (?, ?, ?, ?, 0)
  `);

  const insertBatch = db.transaction((rows: SnapshotManifestVector[]) => {
    for (const rec of rows) {
      const floatBuf = Buffer.from(new Float32Array(rec.vector).buffer);
      insertStmt.run(rec.pathHash, rec.fullPath, floatBuf, JSON.stringify(rec.metadata));
    }
  });

  try {
    const baseStream = fs.createReadStream(baselineJsonlPath, { encoding: 'utf8' });
    const baseRl = readline.createInterface({ input: baseStream, crlfDelay: Infinity });
    let batch: SnapshotManifestVector[] = [];

    for await (const line of baseRl) {
      if (!line.trim()) continue;
      batch.push(JSON.parse(line));
      if (batch.length >= 10000) {
        insertBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) insertBatch(batch);

    const selectStmt = db.prepare(
      'SELECT full_path, vector_blob, metadata_json FROM baseline WHERE path_hash = ?'
    );
    const markSeenStmt = db.prepare('UPDATE baseline SET seen = 1 WHERE path_hash = ?');

    const alerts: SnapshotDiffAlert[] = [];
    let added = 0;
    let modified = 0;
    let deleted = 0;
    let seenQueue: string[] = [];

    const flushSeen = db.transaction((hashes: string[]) => {
      for (const h of hashes) markSeenStmt.run(h);
    });

    const targetStream = fs.createReadStream(targetJsonlPath, { encoding: 'utf8' });
    const targetRl = readline.createInterface({ input: targetStream, crlfDelay: Infinity });

    for await (const line of targetRl) {
      if (!line.trim()) continue;
      const targetRec: SnapshotManifestVector = JSON.parse(line);
      const row = selectStmt.get(targetRec.pathHash) as
        | { full_path: string; vector_blob: Buffer; metadata_json: string }
        | undefined;

      if (!row) {
        added++;
        const zeroVec = new Array(targetRec.vector.length).fill(0);
        const dist = computeEuclideanDistance(zeroVec, targetRec.vector);
        const changedDims = VECTOR_DIMENSIONS.filter((_, idx) => targetRec.vector[idx] > 0);
        const severity = calculateSeverity('ADDED', targetRec.vector, dist, changedDims);

        if (severity >= minSeverityThreshold) {
          alerts.push({
            status: 'ADDED',
            fullPath: targetRec.fullPath,
            pathHash: targetRec.pathHash,
            severityScore: severity,
            euclideanDistance: Number(dist.toFixed(4)),
            cosineSimilarity: 0,
            changedDimensions: [...changedDims],
            target: targetRec.metadata,
          });
        }
      } else {
        seenQueue.push(targetRec.pathHash);
        if (seenQueue.length >= 10000) {
          flushSeen(seenQueue);
          seenQueue = [];
        }

        const baseFloat32 = new Float32Array(
          row.vector_blob.buffer,
          row.vector_blob.byteOffset,
          row.vector_blob.byteLength / 4
        );
        const baseVec = Array.from(baseFloat32);
        const dist = computeEuclideanDistance(baseVec, targetRec.vector);

        if (dist > 0.001) {
          modified++;
          const cosSim = computeCosineSimilarity(baseVec, targetRec.vector);
          const changedDims = VECTOR_DIMENSIONS.filter(
            (_, idx) => Math.abs(baseVec[idx] - targetRec.vector[idx]) > 0.001
          );
          const severity = calculateSeverity('MODIFIED', targetRec.vector, dist, changedDims);

          if (severity >= minSeverityThreshold) {
            alerts.push({
              status: 'MODIFIED',
              fullPath: targetRec.fullPath,
              pathHash: targetRec.pathHash,
              severityScore: severity,
              euclideanDistance: Number(dist.toFixed(4)),
              cosineSimilarity: Number(cosSim.toFixed(4)),
              changedDimensions: [...changedDims],
              baseline: JSON.parse(row.metadata_json),
              target: targetRec.metadata,
            });
          }
        }
      }
    }

    if (seenQueue.length > 0) flushSeen(seenQueue);

    const unseenIter = db
      .prepare('SELECT path_hash, full_path, vector_blob, metadata_json FROM baseline WHERE seen = 0')
      .iterate() as IterableIterator<{
      path_hash: string;
      full_path: string;
      vector_blob: Buffer;
      metadata_json: string;
    }>;

    for (const row of unseenIter) {
      deleted++;
      const baseFloat32 = new Float32Array(
        row.vector_blob.buffer,
        row.vector_blob.byteOffset,
        row.vector_blob.byteLength / 4
      );
      const baseVec = Array.from(baseFloat32);
      const zeroVec = new Array(baseVec.length).fill(0);
      const dist = computeEuclideanDistance(baseVec, zeroVec);
      const changedDims = VECTOR_DIMENSIONS.filter((_, idx) => baseVec[idx] > 0);
      const severity = calculateSeverity('DELETED', baseVec, dist, changedDims);

      if (severity >= minSeverityThreshold) {
        alerts.push({
          status: 'DELETED',
          fullPath: row.full_path,
          pathHash: row.path_hash,
          severityScore: severity,
          euclideanDistance: Number(dist.toFixed(4)),
          cosineSimilarity: 0,
          changedDimensions: [...changedDims],
          baseline: JSON.parse(row.metadata_json),
        });
      }
    }

    alerts.sort((a, b) => b.severityScore - a.severityScore);
    const outStream = fs.createWriteStream(diffOutputJsonlPath, { flags: 'w' });
    for (const alert of alerts) {
      outStream.write(JSON.stringify(alert) + '\n');
    }

    await new Promise<void>((resolve, reject) => {
      outStream.on('finish', resolve);
      outStream.on('error', reject);
      outStream.end();
    });

    return {
      added,
      modified,
      deleted,
      alertsEmitted: alerts.length,
    };
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(tempDbPath + suffix)) {
        fs.unlinkSync(tempDbPath + suffix);
      }
    }
  }
}
