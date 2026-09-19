# Video Chat deployment environment

Set these values in deployment-provider dashboards; do not commit their values
to `render.yaml`, `fly.toml`, `vercel.json`, or a tracked `.env` file.

| Provider | Variable | Value |
| --- | --- | --- |
| Render or Fly (backend) | `TURN_USERNAME` | OpenRelay/Metered TURN username (secret) |
| Render or Fly (backend) | `TURN_CREDENTIAL` | OpenRelay/Metered TURN credential (secret) |
| Render or Fly (backend) | `FRONTEND_ORIGIN` | Exact Vercel production origin, e.g. `https://your-app.vercel.app` (no trailing slash) |
| Vercel (frontend) | `VITE_WS_URL` | Public secure WebSocket URL for the backend, e.g. `wss://your-backend.fly.dev` |

`TURN_USERNAME` and `TURN_CREDENTIAL` belong only on the backend: they must
never be named with a `VITE_` prefix. Vercel has no backend runtime for this
project, so it only needs `VITE_WS_URL`.

Render declares backend values with `sync: false`; fill them in through the
Render dashboard. For Fly, run:

```sh
fly secrets set TURN_USERNAME=... TURN_CREDENTIAL=... FRONTEND_ORIGIN=https://your-app.vercel.app
```

The backend health probe is `GET /health` and responds with `{"status":"ok"}`.
