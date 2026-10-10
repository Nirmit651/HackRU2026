# Live Scarlet market deployment

GitHub Pages hosts the React frontend. The Express API, PostgreSQL database and automation worker must run separately. This repository includes a Render blueprint for the API and worker in [`render.yaml`](../render.yaml).

## 1. Deploy the backend

Create the two Render services from `render.yaml`, or run the API and worker on another Node host. Supply:

- `DATABASE_URL`: runtime PostgreSQL connection
- `DIRECT_DATABASE_URL`: migration-owner PostgreSQL connection
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_PUBLISHABLE_KEY`: browser-safe Supabase publishable key
- `APP_ORIGIN`: the Pages origin, for example `https://tanish-banota.github.io`
- `NODE_ENV=production` and `LOCAL_DEMO_AUTH=false`

Apply the Prisma migrations once from a migration-capable environment:

```sh
cd vite-project
npm ci
npm run db:generate
npm run db:migrate
```

The backend URL should look like `https://scarlet-market-api.example.com`. Do not include `/api` in the URL used for the frontend variable.

## 2. Configure Supabase Auth

In Supabase Auth URL configuration, add the exact Pages URL:

```text
https://tanish-banota.github.io/HackRU2026/
```

The app uses Supabase email magic links. The first successful sign-in creates the app profile automatically. Admin access is controlled by Supabase `app_metadata.role`, not by browser input.

## 3. Enable GitHub Pages

In the repository settings, set Pages → Build and deployment → Source to **GitHub Actions**. Add a repository variable:

```text
API_ORIGIN=https://scarlet-market-api.example.com
```

The workflow at [`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml) builds `vite-project` with the `/HackRU2026/` project-site base path and deploys `vite-project/dist` on every push to `main`.

The resulting frontend URL is:

```text
https://tanish-banota.github.io/HackRU2026/
```

## 4. Create the Rutgers markets

Configure the football and basketball generators in the Admin view with settings like:

```json
{
  "provider": "ESPN",
  "teamId": 164,
  "maxGames": 1,
  "marketTypes": ["win", "team-points", "total-points"]
}
```

ESPN's public schedule, scoreboard and event-summary endpoints are used server-side, so no ESPN API key is needed. The worker discovers the next scheduled Rutgers game for each sport and creates three idempotent markets. Default thresholds are 24.5 / 48.5 for football and 72.5 / 145.5 for basketball; they are stored in each market's resolution rule and can be overridden in the generator settings.

Run **Sync now** after saving each generator. The worker then keeps the markets monitored and resolves them only after final scores are observed consistently.

For a server-side one-command setup after creating a LIVE environment, use:

```sh
npm run rutgers:setup -- <environment-id>
```

That enables both generators and immediately asks ESPN for the next game in each sport, creating the three markets for each one.

## Local verification

The hosted API path can be tested locally by setting `VITE_API_ORIGIN` to the API origin when building, or use the normal Vite proxy with:

```sh
npm run demo
```

The local demo does not need Supabase or an ESPN key. It uses the existing local demo sign-in and simulated data.
