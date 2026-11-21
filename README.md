Entec Platform Roadmap

Entec is a modular platform for storage diagnostics, snapshot management, data protection, and security monitoring. Development proceeds in six phases:

Website Foundation – Next.js/TypeScript, Payload CMS, branding, responsive dashboard, and core UI components.
Storage Diagnostics – Import/parse directory data (including Windows dir /s), analyze sizes/extensions, aggregate usage, and visualize consumption.
Snapshot Management – Metadata model, inventory/history, native provider integration, and access-controlled operations.
Encryption Services – Architecture, key management, workflows, status monitoring, and auditing.
Intrusion Detection (IDS) – Passive monitoring that detects and alerts on threats (malware behaviors, unauthorized access, C2 indicators, etc.) without automatic blocking. Includes telemetry, classification, alerting, dashboard, and SIEM forwarding.
Platform Expansion – Multi-volume support, advanced analytics, automated reporting, external integrations, and unified storage/security views.
Architecture: Central Next.js dashboard plus subsystems for storage, snapshots, encryption, IDS, and shared analytics/reporting.

Security notes: IDS detects and alerts only; IPS actively blocks; SIEM correlates events. Findings require review.

Principles: Modular design, access controls, full auditability, explainable detections, and API-driven expansion.


## API authentication

The `POST /api/analyze` endpoint is protected with a bearer token when
`ENTEC_API_TOKEN` is configured. Set a high-entropy secret in the server
environment and send it as `Authorization: Bearer <token>` from trusted
server-to-server clients. Never place this token in `public/app.js`, HTML,
or any browser-delivered code.

Production mode (`NODE_ENV=production`) fails closed: if
`ENTEC_API_TOKEN` is missing, analysis requests return HTTP 503. Requests
without a valid token return HTTP 401. In non-production mode, omitting the
token permits analysis only from loopback clients; remote clients still need
a configured token. `GET /api/health` remains unauthenticated for liveness
checks and does not expose configuration or secrets.

Example environment:

```sh
NODE_ENV=production
ENTEC_API_TOKEN=<generate-a-long-random-secret>
```

Use HTTPS or a private network between Entec and TagEngine. Rotate the token
through the deployment secret manager, not source control.


## Persistent snapshot storage API

Set `ENTEC_SNAPSHOT_DIR` to a durable writable directory (default:
`./data/snapshots`). TagEngine stores snapshot source text, parsed JSONL
vectors, and indexed metadata in SQLite. Back up this directory as part of
the deployment's normal data-protection plan.

All snapshot routes require the same bearer authentication as `/api/analyze`.

- `POST /api/snapshots` — JSON body: `{ "snapshotText": "...", "volumeId": "volume-a", "label": "Baseline" }`. Returns HTTP 201 and snapshot metadata after parsing and persisting the snapshot.
- `GET /api/snapshots?volumeId=volume-a&limit=100` — list metadata, optionally filtered by volume. Limit is 1–500.
- `GET /api/snapshots/:uuid` — retrieve one snapshot's metadata.

The API does not return local filesystem paths or raw snapshot contents.
Snapshot source and vector files remain on the TagEngine host. This initial
storage layer has no automatic retention or deletion policy; configure disk
monitoring and backups before production use. Use a persistent volume for
`ENTEC_SNAPSHOT_DIR`; ephemeral container filesystems will lose stored data.


## Historical snapshot comparisons

The authenticated comparison API compares two snapshots already stored by TagEngine.
It resolves snapshot IDs internally (clients cannot supply filesystem paths), requires
both snapshots to belong to the same `volumeId`, and reparses both source snapshots
using one shared time anchor so recency dimensions are comparable.

- `POST /api/snapshot-comparisons` — JSON body:
  `{ "baselineId": "<uuid>", "targetId": "<uuid>", "minSeverity": 1 }`.
  Returns HTTP 201 with the persisted comparison summary and up to 2,000 highest-ranked
  alerts. `minSeverity` is optional and ranges from 0 to 10.
- `GET /api/snapshot-comparisons?volumeId=volume-a&limit=100` — list comparison
  metadata and counts, optionally filtered by volume. Limit is 1–500.
- `GET /api/snapshot-comparisons/:uuid` — retrieve a saved comparison and up to
  2,000 alerts.

Comparison metadata is stored in SQLite and alert records are stored as JSONL files
inside `ENTEC_SNAPSHOT_DIR`. Back up the complete directory. This release does not
yet provide automatic retention or deletion; disk monitoring remains necessary.
