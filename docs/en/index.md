---
# https://vitepress.dev/reference/default-theme-home-page
layout: home
pageClass: z3r0-docs-home

hero:
  name: Z3r0
  text: Intelligent Multi-agent Security Assessment Workbench
  tagline: Open-source multi-agent security assessment workbench for intelligent, operator-guided automation of authorized penetration testing, vulnerability discovery, code auditing, and technical research
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
  - title: Multi-agent orchestration
    details: A lead agent coordinates specialist agents for asset intelligence, validation, code audit, reverse analysis, and cryptographic review.
  - title: Project evidence plane
    details: A work project binds graph-targeted work items to authorized assets, work-item-attributed evidence, validated findings, attack paths, retest candidates, and lead review decisions.
  - title: Retrieval context plane
    details: Building knowledge graphs with LightRAG Core provides matching original document chunks and graph context for task-oriented inputs.
  - title: Replayable event timeline
    details: The UI consumes normalized timeline events that can be streamed live or loaded later as history.
  - title: Distributed sandbox resources
    details: Managed Docker hosts, images, and containers allow execution environments to be isolated, scaled, and assigned to projects.
  - title: Preloaded sandbox toolchain
    details: The default sandbox image provides targeted DNS, HTTP, and service diagnostics plus local artifact, Android, firmware, reverse engineering, browser, and Python capabilities behind sandbox-local skills.
  - title: Unified egress layer
    details: Container traffic can use direct, managed proxy, or Tor egress; managed proxies support HTTP, HTTPS, and SOCKS5 upstreams.
  - title: Operator workbench
    details: The frontend combines chat, workflow state, graph review, evidence chains, attack paths, sandbox selection, terminal, files, and noVNC.
---

> :warning: **Security and Legal Notice**
>
> Z3r0 assumes that user-provided objectives, targets, and instructions are lawfully authorized for the active engagement. It grants no additional access rights; the active project scope and runtime controls define execution boundaries.
>
> Keep assessment actions bounded, reversible, and proportionate: prefer read-only checks, least-privilege identities, synthetic data, conservative rates, and the narrowest proof needed. Do not materially damage, degrade, or interrupt targets or make unapproved changes to systems or data. Stop when scope, stability, data exposure, or cleanup is uncertain.
>
> **Operators remain responsible for applicable law and contracts. The author and maintainers accept no responsibility for damage, loss, claims, or liability arising from user deployment, configuration, instructions, conduct, or misuse.**
