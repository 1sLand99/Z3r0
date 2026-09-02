---
title: Quick Start
editLink: true
---

# Quick Start

This guide covers configuration, sandbox image build, and deployment of Z3r0's intelligent, operator-guided multi-agent security assessment workbench for authorized penetration testing, vulnerability discovery, code auditing, and research.

> :warning: Authorization and Safety
>
> Z3r0 assumes that deployment and user-provided objectives and targets are lawfully authorized. It grants no additional access rights; the active project scope and runtime controls define execution boundaries.
>
> **Operators remain responsible for deployment, conduct, and compliance with applicable law and contracts. The author and maintainers accept no responsibility for damage, loss, claims, or liability arising from user deployment, configuration, instructions, conduct, or misuse.**

> :warning: Iteration Notice
>
> Z3r0 is under active development. Review release notes before upgrading, pin production deployments to a tested revision, and back up configuration and PostgreSQL data before applying changes.

Before exposing a sandbox or starting an assessment, apply the controls in [Overview](./overview#non-destructive-operation): use an isolated environment, declared scope, least-privilege identities, passive or read-only checks, conservative execution limits, monitored egress, and a documented stop and cleanup path. Do not deploy malware, establish persistence, acquire unauthorized privileges, move laterally, exfiltrate data, perform destructive writes, or exhaust service resources. Isolation and egress controls reduce operational risk but do not expand the active project scope.

## Before You Start

### Basic Configuration

Z3r0 requires the following configuration and infrastructure:

| item | description |
| --- | --- |
| `.z3r0/config.json` | System runtime configuration |
| `.z3r0/agents/*` | Agent role and instruction files |
| `.lightrag/` | Temporary parser inputs and local LightRAG working files |
| `sandbox` | Isolated execution environment |
| Docker | Runtime for sandbox containers |
| PostgreSQL | Persistent application and LightRAG storage with pgvector and Apache AGE extensions |

Get the latest code from GitHub:

```bash
git clone https://github.com/yv1ing/Z3r0.git && cd Z3r0
```

### Build the Sandbox

Build the sandbox image used for isolated task execution:

> :warning: Supported Architecture
>
> The sandbox image build currently supports only the x64/amd64 architecture. arm64/Apple Silicon, including Apple Silicon Macs, is not supported. Run this step on an x64 host or in an x64 build environment.

```bash
cd sandbox && bash build.sh
```

The build output identifies the image tag that it creates. Register that exact tag in `Sandbox Images` before creating a container; if you customize `sandbox/build.sh`, update the image record to match.

## Production Environment

Complete the following steps for a production deployment.

### Prepare Configuration

```bash
cp .z3r0/config.json.example .z3r0/config.json
```

Edit the system runtime configuration in `.z3r0/config.json`, mainly updating the following items:

| item | description |
| --- | --- |
| `system.encrypt_key` | System data encryption key. This must be changed. A random string of at least 32 bytes is recommended. |
| `system.bootstrap_admin` | Default system administrator information. This must be changed. A strong password is recommended. |
| `database` | System database connection information. The bundled production Compose deployment uses host networking, so `host` remains `127.0.0.1`. |
| `agents.*` | LLM API configuration for each agent. Providers and models can be configured separately by role. |
| `lightrag.embedding_*` | OpenAI-compatible embedding API, key, model, and vector dimension. |
| `lightrag.llm_*` | Independent OpenAI-compatible LLM API, key, and model used for entity and relationship extraction. |
| `lightrag.graph_matches` | Number of entity and relationship matches included in graph retrieval context. |
| `lightrag.chunk_matches` | Number of original document chunks included in text retrieval context. |

LightRAG uses `lightrag.llm_*` independently from the agent models in `agents.*`. Select the embedding API, model, and dimension before the first import; later changes may require rebuilding the indexed collection. Other retrieval and extraction settings can be managed through `System Config`.

### Start Containers

Once everything is ready, start Z3r0 with one command:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### Reverse Proxy (Optional)

By default, the service listens on `0.0.0.0:8000`. For public deployments, bind it to a trusted interface and place it behind a TLS-terminating reverse proxy that supports WebSocket upgrades and long-lived connections. Apply independent authentication and access controls at the proxy.

## Development Environment

Use the following setup for local development.

### Configure the Environment

- Python version: 3.13.5
- Node.js version: 24.18.0

Create a virtual environment with the following commands:

```bash
python -m venv .venv

# Windows:
.venv\Scripts\Activate.ps1

# Linux:
source .venv/bin/activate
```

Install system dependencies:

```bash
pip install -r requirements.txt
```

```bash
cd web && npm ci
```

Build the frontend project:

```bash
cd web && npm run build
```

### Start PostgreSQL

Start the development database services:

```bash
docker compose -f docker-compose.dev.yml up -d
```

The Compose service creates the `z3r0` database automatically. PostgreSQL is available on `127.0.0.1:5432`. pgAdmin is available as an optional administration interface at `http://127.0.0.1:5433` using the credentials defined in `docker-compose.dev.yml`.

### Start the Project

Create `.z3r0/config.json` and fill in the relevant information based on the example in `.z3r0/config.json.example`.

Start the project with the following command:

```bash
python main.py
```

By default, the service listens on `0.0.0.0:8000`. Visit `http://127.0.0.1:8000/` to access it.

## Next Step

Continue with [First Use](./first-use) to configure execution resources and create a project.
