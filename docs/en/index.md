---
# https://vitepress.dev/reference/default-theme-home-page
layout: home
pageClass: z3r0-docs-home

hero:
  name: Z3r0
  text: Security Assessment Workbench
  tagline: A multi-Agent collaboration platform for authorized testing, risk analysis, and technical research
  image:
    src: /z3r0-logo.png
    alt: Z3r0 logo
  actions:
    - theme: brand
      text: Quick Start
      link: /en/guide/quick-start
    - theme: alt
      text: Documentation
      link: /en/guide/overview

features:
  - title: Multi-Agent orchestration
    details: A lead Agent coordinates specialist Agents for asset intelligence, validation, code audit, reverse analysis, and cryptographic review.
  - title: Project evidence plane
    details: WorkProject binds graph-targeted WorkItems to authorized assets, WorkItem-attributed evidence, validated findings, assessment paths, retest candidates, and lead review decisions.
  - title: Retrieval context plane
    details: Building knowledge graphs with LightRAG Core provides matching original document chunks and graph context for task-oriented inputs.
  - title: Replayable event timeline
    details: The UI consumes normalized timeline events that can be streamed live or loaded later as history.
  - title: Distributed sandbox resources
    details: Managed Docker hosts, images, and containers allow execution environments to be isolated, scaled, and assigned to projects.
  - title: Preloaded sandbox toolchain
    details: The default sandbox image provides targeted DNS, HTTP, and service diagnostics plus local artifact, Android, firmware, reverse engineering, browser, and Python capabilities behind sandbox-local skills.
  - title: Unified egress layer
    details: Container traffic can be routed through direct, HTTP, HTTPS, or SOCKS5 modes using one platform-managed policy surface.
  - title: Operator workbench
    details: The frontend combines chat, workflow state, graph review, evidence chains, assessment paths, sandbox selection, terminal, files, and noVNC.
---

> :warning: **Security and Legal Notice**
>
> Use Z3r0 only for lawful security assessment, risk analysis, code auditing, or technical research within a documented scope and with prior written authorization from the system owner or engagement authority defining permitted assets, methods, timing, data handling, monitoring, stop conditions, and cleanup. Z3r0 grants no permission to access or test third-party systems or data. Any unauthorized, unlawful, or malicious attack, intrusion, compromise, disruption, or data activity is strictly prohibited.
>
> **Users bear sole responsibility for applicable law and contracts. The author and maintainers accept no responsibility for any damage, loss, claim, or legal liability arising from user deployment, configuration, instructions, conduct, or unauthorized use.**
