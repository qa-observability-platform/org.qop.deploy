# QOP — QA Observability Platform

> The open-source test observability platform. Real-time test execution monitoring, AI-powered flaky test detection, and multi-framework support.

## Self-Hosted Setup

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed
- [Docker Compose](https://docs.docker.com/compose/install/) v2+

### 1. Clone this repo

```bash
git clone https://github.com/qa-observability-platform/org.qop.deploy.git
cd org.qop.deploy
```

### 2. Configure environment

```bash
cp .env.docker.example .env.docker
```

Edit `.env.docker` and set:

| Variable | Description |
|---|---|
| `POSTGRES_DB` | Database name (e.g. `qop_db`) |
| `POSTGRES_USER` | Database username (e.g. `qop_user`) |
| `POSTGRES_PASSWORD` | Database password — set once, never change after first run |
| `JWT_SECRET` | JWT signing secret — run `openssl rand -hex 32` |
| `QOP_API_URL` | Public URL of your server (e.g. `http://your-server-ip:4000`) |
| `QOP_WS_URL` | WebSocket URL (e.g. `ws://your-server-ip:4000`) |
| `GROQ_API_KEY` | (Optional) Groq API key for AI features — free at [console.groq.com](https://console.groq.com) |

### 3. Pull images & start QOP

```bash
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

This pulls pre-built images from Docker Hub and starts 4 services:

| Service | Port | Description |
|---|---|---|
| PostgreSQL | 5433 | Database |
| Node.js API | 4000 | Core backend + WebSocket |
| Python AI API | 8000 | Flaky detection + AI analysis |
| Web Dashboard | 3000 | Next.js frontend |

### 4. Verify everything is running

Check all containers are healthy:
```bash
docker compose ps
```

Check the API and database are connected:
```bash
curl http://localhost:4000/ready
# ✅ {"status":"ready","db":"ok"}
# ❌ {"status":"unhealthy","db":"error"}  ← database not connected
```

Check API is alive (no DB needed):
```bash
curl http://localhost:4000/health
# {"status":"ok"}
```

View logs if something is wrong:
```bash
docker compose logs nodeapi     # Node.js API logs
docker compose logs postgres    # Database logs
docker compose logs web         # Frontend logs
```

### 5. Access the dashboard

Open [http://localhost:3000](http://localhost:3000) and create your account.

---

## Updating

```bash
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

## Stop

```bash
docker compose down
```

> **Note:** Data is stored in a Docker volume (`qop_postgres_data`) and persists across restarts. To delete all data: `docker compose down -v`

---

## Troubleshooting

**`password authentication failed for user "qop_user"`**

Your `POSTGRES_PASSWORD` in `.env.docker` doesn't match what the database was initialized with. Reset with:
```bash
docker compose --env-file .env.docker down -v
docker compose --env-file .env.docker up -d
```
> This wipes all data and starts fresh with the current password.

**`required variable POSTGRES_PASSWORD is missing`**

You ran `docker compose up` without the env file flag. Always use:
```bash
docker compose --env-file .env.docker up -d
```

---

## Integrating Test Frameworks

Install the reporter for your framework:

**Playwright**
```bash
npm install @qa-observability-platform/playwright
```

**Puppeteer / Jest**
```bash
npm install @qa-observability-platform/puppeteer
```

**Pytest**
```bash
pip install qa-observability-platform-pytest
```

**Selenium / TestNG** — coming soon via JitPack.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│              Test Runners                   │
│  Playwright · Puppeteer · Pytest · Selenium │
└──────────────────┬──────────────────────────┘
                   │ WebSocket (ws://host:4000/ws/ingest)
┌──────────────────▼──────────────────────────┐
│           Node.js API (port 4000)           │
│     Express · WebSocket · JWT · Knex        │
└──────┬───────────────────────┬──────────────┘
       │ PostgreSQL             │ HTTP
┌──────▼──────┐    ┌───────────▼───────────────┐
│  PostgreSQL │    │  Python AI API (port 8000) │
│  (port 5433)│    │  FastAPI · Claude/GPT/Groq │
└─────────────┘    └───────────────────────────┘
┌─────────────────────────────────────────────┐
│        Next.js Dashboard (port 3000)        │
└─────────────────────────────────────────────┘
```

---

## Source Code

| Repo | Description |
|---|---|
| [org.qop.nodeapi](https://github.com/qa-observability-platform/org.qop.nodeapi) | Node.js backend |
| [org.qop.pythonapi](https://github.com/qa-observability-platform/org.qop.pythonapi) | Python AI backend |
| [org.qop.web](https://github.com/qa-observability-platform/org.qop.web) | Next.js frontend |

---

## License

MIT
