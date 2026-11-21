import * as fs from 'fs';
import * as readline from 'readline';
import * as crypto from 'crypto';

export interface SnapshotManifestVector {
  volumeSerial: string;
  fullPath: string;
  pathHash: string;
  vector: number[]; // 12-dimensional normalized feature vector [0.0 - 1.0]
  metadata: {
    entryType: 'FILE' | 'DIR' | 'JUNCTION' | 'SYMLINKD';
    sizeBytes: number;
    timestampIso: string;
    extension: string;
  };
}

export const VECTOR_DIMENSIONS = [
  'isExecutable',
  'isArchiveOrImage',
  'isScriptOrConfig',
  'isRecycleBin',
  'isSystemOrProgramPath',
  'isHiddenOrDotPath',
  'isReparsePoint',
  'isDirectory',
  'pathDepthNorm',
  'logSize',
  'recentMtimeScore',
  'timestampSkewAnomaly',
] as const;

const EXEC_EXTS = new Set([
  '.exe', '.dll', '.sys', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.scr', '.com', '.winmd', '.node',
]);

const ARCHIVE_EXTS = new Set([
  '.zip', '.7z', '.tar', '.gz', '.xz', '.iso', '.cab', '.rar', '.archive', '.vhdx', '.vmdk',
]);

const SCRIPT_CFG_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.sh', '.json', '.jsonc', '.xml', '.inf', '.ini', '.cfg', '.yml', '.yaml', '.toml',
]);

const ENTRY_REGEX =
  /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}\s+[AP]M)\s+(?:(<DIR>|<JUNCTION>|<SYMLINKD>)|([\d,]+))\s+(.+)$/;

const DIR_HEADER_REGEX = /^\s*Directory of (.+)$/;
const SERIAL_REGEX = /^\s*Volume Serial Number is ([0-9A-Fa-f-]+)$/;

export function parseWindowsTimestamp(dateStr: string, timeStr: string): number {
  const [month, day, year] = dateStr.split('/').map(Number);
  const [clock, meridiem] = timeStr.split(/\s+/);
  let [hours, minutes] = clock.split(':').map(Number);

  if (meridiem === 'PM' && hours !== 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;

  return Date.UTC(year, month - 1, day, hours, minutes, 0);
}

export function getExtension(name: string): string {
  const cleanName = name.split(' [')[0];
  const idx = cleanName.lastIndexOf('.');
  return idx > 0 ? cleanName.slice(idx).toLowerCase() : '';
}

export function buildManifestVector(
  fullPath: string,
  entryType: 'FILE' | 'DIR' | 'JUNCTION' | 'SYMLINKD',
  sizeBytes: number,
  epochMs: number,
  referenceEpochMs: number
): number[] {
  const lowerPath = fullPath.toLowerCase();
  const ext = getExtension(fullPath);
  const segments = fullPath.split('\\').filter(Boolean);
  const baseName = segments[segments.length - 1] || '';

  const isExecutable = entryType === 'FILE' && EXEC_EXTS.has(ext) ? 1 : 0;
  const isArchiveOrImage = entryType === 'FILE' && ARCHIVE_EXTS.has(ext) ? 1 : 0;
  const isScriptOrConfig = entryType === 'FILE' && SCRIPT_CFG_EXTS.has(ext) ? 1 : 0;
  const isRecycleBin = lowerPath.includes('\\$recycle.bin\\') ? 1 : 0;
  const isSystemOrProgramPath =
    lowerPath.startsWith('c:\\windows\\') ||
    lowerPath.startsWith('c:\\program files\\') ||
    lowerPath.startsWith('c:\\program files (x86)\\')
      ? 1
      : 0;

  const isHiddenOrDotPath =
    segments.some((s) => s.startsWith('.') || s.startsWith('$')) || baseName.startsWith('.') ? 1 : 0;
  const isReparsePoint = entryType === 'JUNCTION' || entryType === 'SYMLINKD' ? 1 : 0;
  const isDirectory = entryType !== 'FILE' ? 1 : 0;

  const pathDepthNorm = Math.min(segments.length / 15.0, 1.0);
  const logSize = entryType === 'FILE' ? Math.min(Math.log10(sizeBytes + 1) / 10.0, 1.0) : 0;

  const ageMs = Math.max(0, referenceEpochMs - epochMs);
  const recentMtimeScore = Math.exp(-ageMs / (7 * 24 * 60 * 60 * 1000));

  const year = new Date(epochMs).getUTCFullYear();
  const timestampSkewAnomaly = epochMs > referenceEpochMs || year < 2015 ? 1 : 0;

  return [
    isExecutable,
    isArchiveOrImage,
    isScriptOrConfig,
    isRecycleBin,
    isSystemOrProgramPath,
    isHiddenOrDotPath,
    isReparsePoint,
    isDirectory,
    Number(pathDepthNorm.toFixed(4)),
    Number(logSize.toFixed(4)),
    Number(recentMtimeScore.toFixed(4)),
    timestampSkewAnomaly,
  ];
}

/**
 * Pass 1 helper: scans a snapshot file to find the newest timestamp as a deterministic anchor.
 */
export async function detectSnapshotAnchorEpoch(snapshotTxtPath: string): Promise<number> {
  const fileStream = fs.createReadStream(snapshotTxtPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let maxEpoch = 0;

  for await (const line of rl) {
    const entryMatch = line.match(ENTRY_REGEX);
    if (!entryMatch) continue;
    const epoch = parseWindowsTimestamp(entryMatch[1], entryMatch[2]);
    if (epoch > maxEpoch) {
      maxEpoch = epoch;
    }
  }

  return maxEpoch > 0 ? maxEpoch : Date.now();
}

/**
 * Streams a Windows `dir /s` snapshot text file and emits 12D JSONL vectors.
 */
export async function parseDirSnapshotToVectors(
  snapshotTxtPath: string,
  outputJsonlPath: string,
  explicitAnchorEpochMs?: number
): Promise<{ processedCount: number; volumeSerial: string; anchorIso: string }> {
  const referenceEpochMs =
    explicitAnchorEpochMs !== undefined
      ? explicitAnchorEpochMs
      : await detectSnapshotAnchorEpoch(snapshotTxtPath);

  const fileStream = fs.createReadStream(snapshotTxtPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  const outStream = fs.createWriteStream(outputJsonlPath, { flags: 'w' });

  let volumeSerial = 'UNKNOWN';
  let currentDir = '';
  let processedCount = 0;

  for await (const line of rl) {
    const serialMatch = line.match(SERIAL_REGEX);
    if (serialMatch) {
      volumeSerial = serialMatch[1];
      continue;
    }

    const dirMatch = line.match(DIR_HEADER_REGEX);
    if (dirMatch) {
      currentDir = dirMatch[1].trim().replace(/\\$/, '');
      continue;
    }

    const entryMatch = line.match(ENTRY_REGEX);
    if (!entryMatch || !currentDir) continue;

    const [, dateStr, timeStr, dirTag, sizeStr, rawName] = entryMatch;
    const cleanName = rawName.split(' [')[0].trim();

    if (cleanName === '.' || cleanName === '..') continue;

    const entryType: 'FILE' | 'DIR' | 'JUNCTION' | 'SYMLINKD' =
      dirTag === '<DIR>'
        ? 'DIR'
        : dirTag === '<JUNCTION>'
        ? 'JUNCTION'
        : dirTag === '<SYMLINKD>'
        ? 'SYMLINKD'
        : 'FILE';

    const sizeBytes = sizeStr ? Number(sizeStr.replace(/,/g, '')) : 0;
    const epochMs = parseWindowsTimestamp(dateStr, timeStr);
    const fullPath = `${currentDir}\\${cleanName}`;
    const pathHash = crypto.createHash('sha256').update(fullPath.toLowerCase()).digest('hex');

    const vector = buildManifestVector(fullPath, entryType, sizeBytes, epochMs, referenceEpochMs);

    const record: SnapshotManifestVector = {
      volumeSerial,
      fullPath,
      pathHash,
      vector,
      metadata: {
        entryType,
        sizeBytes,
        timestampIso: new Date(epochMs).toISOString(),
        extension: entryType === 'FILE' ? getExtension(cleanName) : '',
      },
    };

    outStream.write(JSON.stringify(record) + '\n');
    processedCount++;
  }

  await new Promise<void>((resolve, reject) => {
    outStream.on('finish', resolve);
    outStream.on('error', reject);
    outStream.end();
  });

  return {
    processedCount,
    volumeSerial,
    anchorIso: new Date(referenceEpochMs).toISOString(),
  };
}
