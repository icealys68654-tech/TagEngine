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
