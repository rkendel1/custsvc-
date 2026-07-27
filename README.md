# KnowledgeOS

KnowledgeOS is a multi-tenant company intelligence platform that turns enterprise documents, policies, process knowledge, and system integrations into a secure, role-aware AI runtime for both employees and customers.

It is not only a chatbot. It is a complete intelligence operating layer that supports:

- Internal operations assistants for teams (support, product, engineering, legal, compliance, operations, leadership)
- External customer-facing AI support experiences
- Structured process execution with approval flows
- Connector-based ingestion and synchronization from business systems
- Browser-local and server-side hybrid AI retrieval patterns

## What This Is

KnowledgeOS provides four core capabilities in one system:

1. Knowledge ingestion and normalization
2. Intelligence compilation into runtime bundles
3. Multi-tenant retrieval and process runtime
4. Analytics and governance loops for continuous improvement

The result is an organization-specific AI layer that can safely answer questions, guide processes, execute allowed actions, and reveal where knowledge gaps are costing time or customer trust.

## How It Works

### 1) Ingest and model enterprise knowledge

KnowledgeOS ingests document content from text, URL, PDF, and connector-backed sources. Each record is normalized with metadata such as:

- Tenant scope
- Audience and visibility
- Source provenance
- Ownership and review cadence

### 2) Build a structured intelligence bundle

The compiler transforms raw documents into a runtime-ready bundle that includes:

- Knowledge objects and chunks
- Relationship graph and process graph
- Runtime model metadata
- Storage profile information
- Validation signals (duplicates, contradictions, stale content)

### 3) Serve runtime APIs with strict tenant boundaries

At runtime, APIs enforce tenant-scoped access and role-aware behavior:

- Tenant isolation across documents, sources, retrieval, analytics, and vectors
- Owner/Admin controls for connector mutation and audit endpoints
- Audience-aware retrieval before ranking

### 4) Hybrid retrieval with pgvector and browser-local embeddings

KnowledgeOS supports vector retrieval with PostgreSQL + pgvector while generating embeddings browser-side for low marginal token cost.

- Vectors are stored by tenant in PostgreSQL
- Search endpoint performs tenant-scoped cosine retrieval
- Browser-local embedding generation avoids external embedding token spend

### 5) Actionable execution and approvals

Capabilities, connectors, and process steps can execute actions with explicit policy and approval controls.

- Capability registry with risk and permission metadata
- Human-in-the-loop approval/rejection paths
- Full execution and audit history

### 6) Learn from telemetry

Runtime telemetry captures intent and outcome signals (privacy-preserving defaults), allowing teams to:

- Identify unresolved customer intents
- Detect documentation gaps
- Improve onboarding and product UX
- Prioritize process and policy updates

## Why This Is Valuable

### External customer value

KnowledgeOS improves customer experience by providing:

- Faster, more accurate answers
- Consistent policy and process responses
- Better 24x7 support coverage
- Lower response latency for common questions
- Improved escalation quality with context-aware routing

### Internal enterprise value

KnowledgeOS improves internal operations through:

- Faster employee knowledge access
- Standardized process execution and decision support
- Lower support burden on SMEs and senior operators
- Better compliance posture through auditability and access controls
- Cross-functional visibility into knowledge quality and operational friction

### Business impact

Teams typically target outcomes like:

- Lower support ticket cost per resolution
- Higher first-contact resolution rates
- Reduced onboarding time for new staff
- Fewer policy/process errors
- Better CSAT and trust through consistent answers

## Internal + External Service Excellence

KnowledgeOS is designed to serve both inside and outside the organization without splitting into disconnected systems.

### Internally

- Support teams get policy-accurate guidance and process copilots
- Product and engineering teams see recurring customer confusion patterns
- Compliance and legal teams gain auditable control over knowledge visibility and updates
- Executives receive trend-level intelligence on friction, risk, and service quality

### Externally

- Customers get consistent, trustworthy answers
- Public knowledge and policy responses remain aligned with internal truth
- Escalations route with better context and less repetition
- Service quality improves as telemetry drives continuous knowledge refinement

## Security, Isolation, and Governance

KnowledgeOS includes foundational enterprise controls:

- Multi-tenant isolation across data, source config, analytics, and vectors
- Encrypted connector secrets with key-version metadata
- Connector audit logs for source lifecycle and health-test events
- Role-based endpoint enforcement for sensitive operations
- Production safeguard requiring connector secret key

These controls are designed to support high-trust deployment in environments where cross-tenant bleed, weak secret handling, or unaudited connector changes are unacceptable.

### Temporary setup mode (security relaxed)

For initial platform bootstrap and data loading, you can temporarily relax auth/session/role enforcement.

- Set one of the following environment variables to enable setup mode:
  - `KNOWLEDGEOS_RELAX_SECURITY=true`
  - `KNOWLEDGEOS_SETUP_MODE=true`
  - `SETUP_MODE=true`
- In setup mode:
  - Console password checks are bypassed.
  - Tenant session checks are bypassed.
  - Owner/Admin role checks are bypassed.
  - APIs default to tenant `public` when no tenant is provided.
- Verify status at `GET /api/system/status` under `setup_mode.security_relaxed`.

Important:

- Use setup mode only in trusted environments.
- Disable setup mode immediately after initial data setup.
- Never keep setup mode enabled in production.

## Architecture Summary

```text
Enterprise Sources + Documents
            |
            v
Ingestion + Normalization
            |
            v
Knowledge Compiler (bundle + graphs + validation)
            |
            v
Runtime APIs (tenant/role aware)
            |
     +------+------+
     |             |
     v             v
PostgreSQL       Browser Runtime
+ pgvector       (local AI + local embeddings)
     |             |
     +------ Retrieval + Process Execution ------+
                          |
                          v
                  Customer + Internal Experiences
                          |
                          v
                     Telemetry + Analytics
                          |
                          v
               Continuous Knowledge Improvement
```

## Technology Highlights

- Node.js + Express runtime
- PostgreSQL for durable storage
- pgvector for semantic retrieval
- Browser-local embedding generation using Transformers.js
- Multi-source connector architecture with real outbound provider checks
- Dockerized local stack and cloud deployment support

## Deployment Model

KnowledgeOS runs locally or in cloud environments such as Fly.io with managed PostgreSQL.

### Managed PostgreSQL (Aiven or equivalent)

- Uses `DATABASE_URL` and standard `PG*` environment variables
- Supports TLS with CA certificate configuration
- Supports pgvector-backed embeddings and search

### Fly.io

- App runs with explicit host and port configuration
- Health endpoint is available at `/health`
- Production requires `SOURCE_SECRET_KEY`

### Deployment reliability and data safety

To keep deployments consistent and avoid accidental data drift/loss:

- The server binds to `0.0.0.0` on port `8080` by default.
- If Postgres is configured, startup retries database initialization before giving up.
- In production, Postgres is required on startup by default. If unavailable, startup fails rather than silently writing lifecycle data to ephemeral JSON.
- During shutdown (`SIGTERM`/`SIGINT`), lifecycle storage is flushed before process exit.

Environment controls:

- `PG_REQUIRE_ON_STARTUP=true|false`
     Default: `true` in production, `false` otherwise.
     When `true`, app fails startup if Postgres lifecycle storage cannot initialize.
- `PG_ALLOW_JSON_FALLBACK=true|false`
     Default: `false`.
     When `true`, app may fallback to JSON lifecycle storage if Postgres is unavailable.
- `PG_CONNECT_RETRIES=<number>`
     Default: `8`.
     Number of lifecycle init retry attempts on startup.
- `PG_CONNECT_RETRY_DELAY_MS=<number>`
     Default: `1500`.
     Base backoff delay used between retries.

Postgres TLS behavior:

- `PGSSLMODE=verify-full`:
     Enforces full CA validation (recommended when CA is configured correctly).
- `PGSSLMODE=require`:
     Uses encrypted TLS and, by default, allows startup even when CA material is unavailable (to avoid deploy downtime from missing cert paths).
- `PGSSL_STRICT_REQUIRE_CA=true|false`:
     Default: `false`.
     When `true`, `require` mode keeps strict CA verification semantics and may fail startup if CA is missing.

## Quick Start

```bash
npm install
npm start
```

Common routes:

- `/` landing page
- `/admin` admin console
- `/demo` demo environment
- `/health` health check

## Docker Workflows

### Local development (app + Postgres + Adminer)

Optional: copy local docker env template:

```bash
cp .env.docker.dev.example .env
```

Start:

```bash
npm run dev:up
```

Logs:

```bash
npm run dev:logs
```

Stop:

```bash
npm run dev:down
```

Reset local stack and delete compose volumes (fresh DB/data):

```bash
npm run dev:reset
```

Local endpoints:

- App: `http://localhost:${APP_PORT:-3000}`
- Adminer: `http://localhost:${ADMINER_PORT:-8081}`
- Postgres: `localhost:${PG_LOCAL_PORT:-5432}`

### Production container deployment

Create a production env file first:

```bash
cp .env.docker.prod.example .env.prod
```

Then run with your production values loaded (example):

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Build and run with production compose file:

```bash
npm run prod:up
```

Stop:

```bash
npm run prod:down
```

Stop and delete production compose volumes for a clean slate:

```bash
npm run prod:reset
```

Compatibility scripts still available:

- `npm run docker:dev:up|down|logs|reset`
- `npm run docker:prod:up|down|logs|reset`

Required production env values:

- `DATABASE_URL` (or `PGHOST` + `PGPORT` + `PGUSER` + `PGPASSWORD` + `PGDATABASE`)
- `SOURCE_SECRET_KEY`
- `PG_REQUIRE_ON_STARTUP=true`
- `PG_ALLOW_JSON_FALLBACK=false`

Recommended TLS settings:

- Availability-first: `PGSSLMODE=require`, `PGSSL_STRICT_REQUIRE_CA=false`
- Strict CA validation: `PGSSLMODE=verify-full` plus `PGSSLROOTCERT` or `DATABASE_SSL_CA`

## API Surface (Core)

- Documents ingestion and management
- Source templates, source CRUD, source health test, source sync
- Vector search
- Bundle compilation
- Telemetry and analytics
- Tenant lifecycle and onboarding
- Deployment status

## Who Should Use This

KnowledgeOS is a strong fit for organizations that need:

- Reliable customer-facing AI answers
- Internal process intelligence beyond simple FAQ bots
- Multi-tenant isolation and governance controls
- Lower token dependency via local embedding strategy
- A single intelligence layer shared across support, product, ops, and leadership

## Practical Outcome

KnowledgeOS gives organizations a repeatable way to convert scattered docs and tribal knowledge into a governed AI operating layer that improves customer service externally and execution quality internally.

That dual value is the core advantage: one platform, one knowledge truth, two high-impact surfaces.
