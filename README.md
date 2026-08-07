# LittleBot

A Discord bot that automatically captures sales numbers from team members' logout reports and compares them against actual platform data to flag discrepancies.

## Project Structure

```
salesrecon/
├── pnpm-workspace.yaml
├── package.json              # Root workspace config
├── tsconfig.base.json        # Shared TypeScript settings
├── migrations/               # SQL migrations (SQLite dev / PostgreSQL prod)
│   └── 001_initial.sql
└── packages/
    ├── types/                # @salesrecon/types  — shared DTOs & interfaces
    ├── bot/                  # @salesrecon/bot    — Discord bot (discord.js v14)
    ├── api/                  # @salesrecon/api    — Express API (port 3001)
    └── web/                  # @salesrecon/web    — React + Vite dashboard (port 5173)
```

## Quick Start

### Prerequisites

- **Node.js** >= 22
- **pnpm** >= 9 (install via `corepack enable pnpm`)

### Install

```bash
pnpm install
```

### Development

Run each package in its own terminal:

```bash
# Terminal 1 — API (port 3001)
pnpm dev:api

# Terminal 2 — Web dashboard (port 5173)
pnpm dev:web

# Terminal 3 — Bot (requires DISCORD_TOKEN in env)
DISCORD_TOKEN=your-token pnpm dev:bot
```

### Type-check everything

```bash
pnpm typecheck
```

### Database (dev)

```bash
sqlite3 data/littlebot.db < migrations/001_initial.sql
```

## Environment Variables

| Variable        | Description                         | Required |
|-----------------|-------------------------------------|----------|
| `DISCORD_TOKEN` | Discord bot token                   | bot only |
| `PORT`          | API listen port (default: 3001)     | no       |
| `DATABASE_URL`  | SQLite path or PG connection string | api only |

## Slash Commands (bot)

- `/ping` — check if the bot is online
- More commands (setup, reporting) coming soon.

## Migrating to PostgreSQL

The schema in `migrations/001_initial.sql` uses `INTEGER PRIMARY KEY AUTOINCREMENT`.
For PostgreSQL, replace with `BIGSERIAL PRIMARY KEY` and `TEXT` fields with appropriate types (e.g., `TIMESTAMPTZ`).
