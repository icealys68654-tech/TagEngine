# Entec Platform — Development Roadmap

## Overview

Entec is a modular platform for storage diagnostics, snapshot management, data protection, and security monitoring. Its development roadmap is organized into six phases, progressing from the application foundation to integrated storage and cybersecurity capabilities.

## Development Phases

### Phase 1 — Website Foundation

Establish the application framework and core user experience.

- Initialize Next.js and TypeScript.
- Configure Payload CMS.
- Apply Entec branding and typography.
- Build a responsive dashboard layout.
- Create navigation and reusable interface components.

### Phase 2 — Storage Diagnostics

Build tools for importing, analyzing, and visualizing storage information.

- Import directory listings.
- Parse Windows `dir /s` output.
- Extract file sizes and extensions.
- Aggregate storage consumption.
- Visualize storage usage and space distribution.

### Phase 3 — Snapshot Management

Provide inventory and management capabilities for filesystem snapshots.

- Define the snapshot metadata model.
- Implement snapshot inventory and history.
- Integrate filesystem-native snapshot providers.
- Add access-controlled snapshot operations.

### Phase 4 — Encryption Services

Establish secure data-protection workflows and supporting oversight.

- Define the encryption architecture.
- Implement secure key management.
- Integrate encryption workflows.
- Monitor encryption status.
- Establish security auditing.

### Phase 5 — Intrusion Detection System (IDS)

Develop a passive security-monitoring subsystem that identifies suspicious activity, records events, and alerts administrators. The IDS detects and reports potential threats; it does not automatically block them.

#### Architecture and telemetry

- Define IDS components and architecture.
- Identify network and system telemetry sources.
- Design event and alert data models.
- Establish integration paths for SIEM platforms.

#### Malware and threat classification

- Classify common malware behaviors, including information theft, data destruction, propagation, concealment, and resource hijacking.
- Account for spyware, keyloggers, information stealers, ransomware, destructive malware, viruses, worms, trojans, rootkits, cryptominers, and botnet activity.
- Distinguish malicious activity from legitimate dual-use administration tools.
- Assess potentially unwanted programs and adware using behavior, consent, and impact.

#### Detection and alerting

- Monitor unusual network connections and outbound traffic.
- Identify unauthorized access attempts and abnormal system behavior.
- Detect indicators associated with command-and-control communications.
- Record security events and assign severity.
- Provide alert history, filtering, notifications, and investigation records.
- Forward relevant events to SIEM platforms.

#### Monitoring and auditing

- Build a security monitoring dashboard.
- Visualize event categories, severity, and timelines.
- Generate IDS diagnostic reports.
- Maintain timestamped audit trails and access-controlled records.
- Test detection quality and document false-positive handling and system limitations.

### Phase 6 — Platform Expansion

Extend the platform and unify its operational insights.

- Add multi-volume support.
- Develop advanced storage analytics.
- Automate diagnostic reporting.
- Implement storage monitoring.
- Integrate external services and APIs.
- Connect IDS monitoring to the central dashboard.
- Provide unified storage and security reporting.

## Platform Architecture

The platform is organized around a central management dashboard, supported by four functional subsystems and a shared analytics layer.

- **Central application:** Next.js, TypeScript, and Payload CMS.
- **Storage diagnostics:** Directory ingestion, storage analysis, and visualization.
- **Snapshot management:** Snapshot inventory, history, and controlled operations.
- **Encryption services:** Key management, encryption workflows, and auditing.
- **Intrusion detection:** Passive monitoring, threat indicators, event logging, and alerts.
- **Unified analytics and reporting:** Cross-subsystem monitoring, audit information, reports, SIEM forwarding, and API integrations.

## Security Model and Terminology

Keep the responsibilities of related security systems distinct:

- **Intrusion Detection System (IDS):** Monitors activity, identifies potential threats, records events, and generates alerts.
- **Intrusion Prevention System (IPS):** Detects threats and takes active steps to block or prevent them.
- **Security Information and Event Management (SIEM):** Collects and correlates security events from multiple sources to support monitoring and investigation.

The initial Entec IDS scope is passive detection and alerting. Automated blocking or prevention is outside that scope unless a separate IPS capability is explicitly designed and authorized.

## Guiding Principles

- Use modular boundaries between storage, snapshot, encryption, and security capabilities.
- Apply access controls to sensitive operations and records.
- Preserve auditability for security-relevant actions.
- Make detection results explainable and suitable for investigation.
- Treat IDS findings as indicators requiring review, not automatic proof of compromise.
- Expand through well-defined APIs and integrations.

## Roadmap Summary

| Phase | Focus | Outcome |
|---|---|---|
| 1 | Website Foundation | Application framework and dashboard |
| 2 | Storage Diagnostics | Storage ingestion and analysis |
| 3 | Snapshot Management | Snapshot inventory and operations |
| 4 | Encryption Services | Secure data-protection workflows |
| 5 | Intrusion Detection | Passive threat monitoring and alerting |
| 6 | Platform Expansion | Integrated analytics and platform services |
