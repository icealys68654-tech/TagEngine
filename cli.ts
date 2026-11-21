#!/usr/bin/env node
import * as path from 'path';
import * as fs from 'fs';
import { parseDirSnapshotToVectors } from './snapshot-manifest-parser';
import { compareSnapshotVectorsDiskBacked } from './sqlite-snapshot-diff-comparator';

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'parse') {
    const input = getArg(args, '--input');
    const output = getArg(args, '--output') || 'out/vectors.jsonl';
    const anchorStr = getArg(args, '--anchor');

    if (!input) {
      console.error('Usage: entec-ids parse --input <snapshot.txt> [--output <vectors.jsonl>] [--anchor <ISO_DATE>]');
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    const anchorMs = anchorStr ? Date.parse(anchorStr) : undefined;
    const res = await parseDirSnapshotToVectors(input, output, anchorMs);
    console.log(JSON.stringify({ status: 'OK', command: 'parse', ...res, output }, null, 2));
  } else if (command === 'diff') {
    const baseline = getArg(args, '--baseline');
    const target = getArg(args, '--target');
    const output = getArg(args, '--output') || 'out/diff_alerts.jsonl';
    const minSeverity = Number(getArg(args, '--min-severity') || '2.0');

    if (!baseline || !target) {
      console.error(
        'Usage: entec-ids diff --baseline <t0.jsonl> --target <t1.jsonl> [--output <alerts.jsonl>] [--min-severity 2.0]'
      );
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    const summary = await compareSnapshotVectorsDiskBacked(baseline, target, output, minSeverity);
    console.log(JSON.stringify({ status: 'OK', command: 'diff', ...summary, output }, null, 2));
  } else {
    console.log('Entec OS Snapshot IDS Vector CLI');
    console.log('Commands:');
    console.log('  parse  --input <snapshot.txt> [--output <vectors.jsonl>] [--anchor <ISO_DATE>]');
    console.log('  diff   --baseline <t0.jsonl> --target <t1.jsonl> [--output <alerts.jsonl>] [--min-severity <num>]');
  }
}

main().catch((err) => {
  console.error('Fatal CLI error:', err);
  process.exit(1);
});
