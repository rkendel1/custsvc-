# Company Intelligence Runtime

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

## Company Operating System Model v4

The compiler now supports executable `processes[]` as first-class bundle peers to `knowledge[]`.

- New process model fields include ownership, roles, required capabilities/documents, policies, and executable `steps[]`.
- New `process_graph` is compiled alongside the knowledge graph.
- Validation checks include dead-ends, unreachable steps, branch correctness, cycle safety, role/capability mismatches, orphaned processes, and knowledge link integrity.
- Runtime APIs now include: `startProcess`, `resumeProcess`, `completeStep`, `validateStep`, `branch`, `rollback`, and `cancel`.
- Bundle output is now `company.intelligence.bundle.v4` with `models[]` runtime metadata while retaining legacy v2-compatible knowledge/chunk fields.

## Quick start

```bash
npm install
npm start
```

Open:

- `http://localhost:3000/admin` to ingest docs and compile
- `http://localhost:3000/` to use the widget

Note: URL ingestion uses secure mode: provide the source URL plus pasted page content.

## API surface (MVP)

- `GET /health`
- `GET /api/documents`
- `POST /api/documents`
- `POST /api/documents/url`
- `POST /api/documents/pdf` (multipart file upload)
- `POST /api/compile`
- `POST /api/telemetry`
- `GET /api/admin/analytics`

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