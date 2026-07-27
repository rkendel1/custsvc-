# KnowledgeOS

This repository defines a **browser-native organizational intelligence platform**, not just a customer service chatbot.

## Implemented MVP

This repository now includes a working end-to-end MVP:

- Document ingestion APIs for:
  - text/markdown/faq/policy
  - URL fetch + extraction
  - PDF upload + text extraction
- Knowledge compiler that generates:
  - `bundles/company.intelligence.bundle.json`
- Embeddable widget runtime:
  - `<script src="/company-ai.js" ...></script>`
  - local bundle retrieval and scoring in the browser
  - local AI runtime (`WASM` tier first, optional cloud fallback)
  - privacy-preserving telemetry capture (intent/confidence/process outcomes by default)
- Admin console at `/admin`:
  - upload content
  - compile bundle
  - inspect documents
  - inspect analytics and recommendations

## Company Intelligence Model v2

The compiler now emits a richer `company.intelligence.bundle` model:

- `knowledge[]` objects (title, summary, body, owner, department, audience, tags, confidence, review schedule)
- first-class `relationships[]` and `graph` adjacency
- role and audience indexes for retrieval
- duplicate and contradiction detection signals
- freshness/review metadata for governance dashboards

Audience layers:

- `PUBLIC`
- `INTERNAL`
- `CONFIDENTIAL`
- `EXECUTIVE`

Runtime retrieval is now role-aware and department-aware before ranking.

## Company Operating System Model v6

The compiler now supports executable `processes[]` as first-class bundle peers to `knowledge[]`.

- New process model fields include ownership, roles, required capabilities/documents, policies, and executable `steps[]`.
- New `process_graph` is compiled alongside the knowledge graph.
- Validation checks include dead-ends, unreachable steps, branch correctness, cycle safety, role/capability mismatches, orphaned processes, and knowledge link integrity.
- Runtime APIs now include: `startProcess`, `resumeProcess`, `completeStep`, `validateStep`, `branch`, `rollback`, `cancel`, `getStorageStatus`, `getAudienceContext`, `search`, and `getKnowledgeSource`.
- Bundle output is now `company.intelligence.bundle.v6` with enriched `models[]`, `runtime_requirements[]`, and `storage_profile`, while keeping `format_legacy: company.intelligence.bundle.v5` compatibility.

### Enterprise action runtime primitives

The runtime also supports operational execution primitives:

- `capabilities[]` registry entries with provider/auth/risk/permission metadata
- `connectors[]` and `execution_policies[]` in the compiled bundle
- process step support for `Action` + `capability` + `input_mapping`
- runtime APIs for capability execution and human approval flow:
  - `executeCapability`
  - `listCapabilities`
  - `getExecutionHistory`
  - `approve`
  - `reject`

## Quick start

```bash
npm install
npm start
```

Open:

- `http://localhost:3000/` landing page
- `http://localhost:3000/demo` interactive demo (seeded `Acme Manufacturing`)
- `http://localhost:3000/signup` self-service signup
- `http://localhost:3000/onboarding?tenant_id=<tenant>` onboarding wizard
- `http://localhost:3000/tenant` tenant dashboard
- `http://localhost:3000/admin` KnowledgeOS Console
- `http://localhost:3000/` now includes Runtime Diagnostics for browser warmup visibility

## Docker (Fully Contained)

This repository now includes a contained Docker stack with:

- `app` (Node/Express API + static runtime)
- `postgres` (PostgreSQL 16)
- `adminer` (database UI)

Run the stack:

```bash
docker compose up --build
```

Endpoints:

- `http://127.0.0.1:3000` app
- `http://127.0.0.1:8080` adminer

Container persistence:

- app data volume: `app_data`
- app bundles volume: `app_bundles`
- postgres volume: `postgres_data`

Dependency status API:

- `GET /api/system/status` validates Postgres reachability and reports browser runtime asset URLs.

## Browser Runtime Warmup

On page load, the widget runtime now performs warmup automatically:

1. Load bundle from `/bundles/knowledgeos.bundle.json`
2. Initialize AI mode and selected local model metadata
3. Download and initialize the configured browser LLM from model repository (default: `Xenova/LaMini-Neo-125M` via Transformers.js)
4. Initialize browser-local PGlite from `/vendor/pglite/index.js`
5. Seed a PGlite table with bundle chunks and use it during search

Verification options:

- Open `http://127.0.0.1:3000` and inspect Runtime Diagnostics section
- In browser console run:

```js
await window.KnowledgeOSRuntime.getRuntimeDiagnostics()
```

Notes:

- Default local model configuration is emitted by the compiler in `models[]` and points to a real downloadable model repository.
- You can override model selection by passing `options.models` to the compiler or by embedding custom model metadata in your bundle.

Note: URL ingestion uses secure mode: provide the source URL plus pasted page content.

## API surface

- `GET /health`
- `GET /api/documents`
- `POST /api/documents`
- `POST /api/documents/bulk`
- `POST /api/documents/url`
- `POST /api/documents/pdf` (multipart file upload)
- `GET /api/sources`
- `POST /api/sources`
- `POST /api/sources/:sourceId/sync`
- `POST /api/compile`
- `POST /api/telemetry`
- `GET /api/admin/analytics`
- `POST /api/signup`
- `POST /api/tenants`
- `GET /api/tenant`
- `POST /api/onboarding`
- `POST /api/deploy`
- `GET /api/deployment/status`
- `GET /api/demo`

## Positioning

- Customer service chatbot alone: **5/10**
- Browser-native local RAG + organizational intelligence platform: **9/10**

The differentiator is the runtime: a company ships a private intelligence package that runs in a visitor's browser as a temporary local instance.

## Core Architecture

```text
Company Knowledge Base
        |
        v
Postgres + pgvector
        |
 Knowledge Compiler
        |
        v
Company Intelligence Package
        |
        v
Website Embed
        |
        v
Browser Runtime
        |
        +----------------+
        |                |
      PGlite          WASM
        |                |
   Local Vector     Fast Tools
     Search        Processing
        |
        v
Local RAG Agent
        |
        v
Customer Conversation
```

## Why This Matters

### 1) Cost collapse

Inference shifts from centralized cloud calls to browser-local compute whenever possible:

- Near-zero marginal inference cost at high traffic
- Cloud focused on distribution, governance, updates, and analytics

### 2) Privacy as a feature

The intelligence runs inside the browser sandbox, improving privacy posture for regulated environments (healthcare, finance, government, legal, internal enterprise use).

### 3) Questions as telemetry

Conversation data powers a knowledge gap discovery engine:

- intent classification
- documentation gaps
- product confusion signals
- recommendations for docs, onboarding, and UI improvements

## Organizational Intelligence Layer

One shared truth with role-aware visibility:

- Customer: answers
- Support: volume and trends
- Product: root-cause patterns
- Engineering: implementation-level failure signals
- Executive: business impact

## Document Visibility Model

Each knowledge object supports:

- `PUBLIC`
- `INTERNAL`
- `BOTH`

This allows one object to serve external policies and internal exception handling without duplicating sources.

## Product Framing

Primary framing:

- "Deploy your company's intelligence everywhere."
- "A private AI operating layer for every organization."

Customer support widget is the first go-to-market surface, not the full platform identity.

## MVP Slice (v1)

### Inputs

- PDFs
- Markdown
- URLs
- FAQs
- Policies

### Output

- `company.intelligence.bundle`

### Embed

```html
<script src="company-ai.js"></script>
```

### Visitor experience

- floating assistant
- local PGlite DB
- local vector search
- optional remote inference fallback

### Admin experience

- questions asked
- unanswered questions
- knowledge recommendations

## Long-Term Platform

```text
Enterprise Intelligence Runtime
        |
---------------------------------
|               |               |
Customer AI   Employee AI   Executive AI
        |
Browser Runtime (Local data + WASM + AI)
```

Strategic inversion: instead of external AI agents entering companies, companies ship their own intelligence runtime outward.