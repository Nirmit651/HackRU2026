# HackRU 2026 — Scarlet Exchange

The application lives in [`vite-project`](vite-project/README.md): the existing Vite React frontend, TypeScript API/worker, Prisma + Supabase PostgreSQL/Auth/Realtime, and optional Tiger analytics and Solana Devnet verification.

Read the [setup, demo, testing and deployment guide](vite-project/README.md). The [GitHub Pages deployment guide](docs/DEPLOY_GITHUB_PAGES.md) explains the Pages frontend, separate API/worker hosting, Supabase login, and the automated Rutgers sports markets. For manual process control, run `npm run dev`, `npm run api`, and `npm run worker` in separate terminals. No deployment was published.

For the normal local demo, once PostgreSQL and `.env` are configured, run `npm run demo` from the repository root. It creates a fresh DEMO environment, runs the database setup, and starts the API, frontend, and worker together. Press Ctrl+C to stop the processes.
