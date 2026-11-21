const baselineInput = document.getElementById('baselineInput');
const targetInput = document.getElementById('targetInput');
const baselineFile = document.getElementById('baselineFile');
const targetFile = document.getElementById('targetFile');
const minSeverityInput = document.getElementById('minSeverity');
const loadSampleBtn = document.getElementById('loadSampleBtn');
const runAnalyzeBtn = document.getElementById('runAnalyzeBtn');
const exportJsonlBtn = document.getElementById('exportJsonlBtn');
const statusText = document.getElementById('statusText');
const resultsBody = document.getElementById('resultsBody');

let lastPayloadRecords = [];

const SAMPLE_T0 = ` Volume in drive C is Windows-SSD
 Volume Serial Number is A49B-18C2

 Directory of C:\\

06/10/2009  04:42 PM                 0 autoexec.bat
06/10/2009  04:42 PM                 0 config.sys
07/06/2026  10:44 AM           208,433 evasive-docu-flow-crm.zip
11/19/2026  11:15 PM                 0 ssd_snapshot.txt

 Directory of C:\\$Recycle.Bin\\S-1-5-21-384920192-1001

11/19/2026  09:12 PM         1,482,752 $I2R38PO.exe
11/19/2026  09:14 PM    <DIR>          $RQ0CX8C

 Directory of C:\\Windows\\System32

11/18/2026  01:05 AM           412,672 cmd.exe
11/19/2026  10:58 PM    <JUNCTION>     spool_redirect [C:\\Users\\Public\\spool]`;

function wireFileUpload(fileEl, textEl) {
  fileEl.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    textEl.value = await file.text();
    statusText.textContent = `LOADED ${file.name} (${file.size.toLocaleString()} B)`;
  });
}

wireFileUpload(baselineFile, baselineInput);
wireFileUpload(targetFile, targetInput);

loadSampleBtn.addEventListener('click', () => {
  baselineInput.value = SAMPLE_T0;
  targetInput.value = '';
  statusText.textContent = 'SAMPLE MANIFEST LOADED';
});

function severityClass(score) {
  if (score >= 6.0) return 'sev-high';
  if (score >= 3.0) return 'sev-med';
  return 'sev-low';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

runAnalyzeBtn.addEventListener('click', async () => {
  const baselineText = baselineInput.value;
  const targetText = targetInput.value;
  const minSeverity = Number(minSeverityInput.value || 0);

  if (!baselineText.trim()) {
    statusText.textContent = 'ERROR: BASELINE SNAPSHOT REQUIRED';
    return;
  }

  statusText.textContent = 'VECTORIZING SNAPSHOT STREAM...';
  runAnalyzeBtn.disabled = true;

  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineText, targetText, minSeverity }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Analysis failed');

    document.getElementById('metricMode').textContent = data.mode;

    if (data.mode === 'SINGLE_PARSE') {
      document.getElementById('metricCount').textContent = data.processedCount.toLocaleString();
      document.getElementById('metricAlerts').textContent = data.recordsReturned.toLocaleString();
      document.getElementById('metricAnchor').textContent = data.anchorIso.split('T')[0];
      lastPayloadRecords = data.records;

      resultsBody.innerHTML = data.records
        .map(
          (r) => `
          <tr>
            <td class="${severityClass(r.severityScore)}">${r.severityScore.toFixed(2)}</td>
            <td>${escapeHtml(r.metadata.entryType)}</td>
            <td>${escapeHtml(r.fullPath)}</td>
            <td><span class="vec-pill">[${r.vector.join(', ')}]</span></td>
            <td>Size: ${r.metadata.sizeBytes.toLocaleString()} B | ${escapeHtml(r.metadata.timestampIso)}</td>
          </tr>`
        )
        .join('');
    } else {
      document.getElementById('metricCount').textContent =
        `${data.baseline.processedCount} -> ${data.target.processedCount}`;
      document.getElementById('metricAlerts').textContent = data.summary.alertsEmitted.toLocaleString();
      document.getElementById('metricAnchor').textContent = data.sharedAnchorIso.split('T')[0];
      lastPayloadRecords = data.alerts;

      resultsBody.innerHTML = data.alerts
        .map(
          (a) => `
          <tr>
            <td class="${severityClass(a.severityScore)}">${a.severityScore.toFixed(2)}</td>
            <td>${escapeHtml(a.status)}</td>
            <td>${escapeHtml(a.fullPath)}</td>
            <td><span class="vec-pill">d=${a.euclideanDistance} | cos=${a.cosineSimilarity}</span></td>
            <td>${escapeHtml(a.changedDimensions.join(', '))}</td>
          </tr>`
        )
        .join('');
    }

    if (!lastPayloadRecords.length) {
      resultsBody.innerHTML =
        '<tr><td colspan="5" class="empty-row">No records matched the current severity threshold.</td></tr>';
    }

    exportJsonlBtn.disabled = lastPayloadRecords.length === 0;
    statusText.textContent = 'EXECUTION COMPLETE';
  } catch (err) {
    statusText.textContent = `ERROR: ${err.message}`;
  } finally {
    runAnalyzeBtn.disabled = false;
  }
});

exportJsonlBtn.addEventListener('click', () => {
  if (!lastPayloadRecords.length) return;
  const jsonl = lastPayloadRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `entec-ids-vectors-${Date.now()}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
});
