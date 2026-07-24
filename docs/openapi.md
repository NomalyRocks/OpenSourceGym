# OpenAPI & Swagger UI

The API serves a machine-readable OpenAPI 3.1 description of itself, plus a
Swagger UI browser for it. Both live inside the normal API process — there is
no separate docs server and no extra port.

## Where it runs

| What            | URL                                   |
| --------------- | ------------------------------------- |
| Swagger UI      | `http://localhost:3000/api/docs`      |
| Raw JSON spec   | `http://localhost:3000/api/openapi.json` |

Port `3000` is the API's own port (`PORT`, see `apps/api/src/env.ts`). Start it
the usual way — `pnpm dev` at the repo root, or `pnpm --filter @opengym/api dev`
— and the docs come up with it. Mongo and Redis must be running
(`docker compose up`), because the API refuses to boot without them.

The admin panel's Vite dev server proxies `/api` to `localhost:3000`, so
`http://localhost:5173/api/docs` reaches the same UI while `pnpm dev` is up.

## Exposure

Docs are always reachable outside production. In production they are off unless
you opt in:

```bash
ENABLE_API_DOCS=true
```

The gate is a single expression in `apps/api/src/openapi/router.ts`:

```ts
export const apiDocsEnabled = env.nodeEnv !== "production" || env.enableApiDocs;
```

When it is false the routes are never registered, so `/api/docs` and
`/api/openapi.json` 404 rather than returning an empty document.

The spec describes request and response shapes only. It contains no
credentials, no seed data and no member records — but it does enumerate every
endpoint and role requirement, which is reason enough to keep it closed on a
public deployment.

## What is covered

29 paths, 34 operations. Every route in `routes/admin.ts`, `routes/me.ts` and
`routes/devices.ts`, plus `GET /health` and the two docs endpoints themselves.

Operations are tagged by area:

| Tag       | Covers                                     |
| --------- | ------------------------------------------ |
| `admin`   | Staff and admin operations                 |
| `me`      | The signed-in user's own operations        |
| `devices` | Turnstile device management                |
| `system`  | Health and the docs endpoints              |
| `auth`    | BetterAuth-owned identity endpoints        |

Each operation's description ends with its required role (`Gerekli rol: …`),
mirroring the `requireRole(...)` call on the route. Protected operations also
declare the `401` and `403` responses that `requireRole` can produce, including
the `mustChangePassword` block.

### Authentication in the UI

Auth is modelled as an apiKey-in-cookie scheme named `sessionCookie`, matching
BetterAuth's `better-auth.session_token`. Swagger UI is configured with
`withCredentials: true`, so if you are already signed in to the panel in the
same browser, "Try it out" sends your session cookie and protected endpoints
work without any extra setup. There is no Authorize button to fill in — the
cookie is not readable from JavaScript, by design.

### BetterAuth endpoints

`/api/auth/*` is a catch-all owned by BetterAuth and mounted before
`express.json()`. Those routes are not introspectable from our side, so the
spec **describes** a representative set (sign-up, sign-in, sign-out, session,
e-mail OTP send/verify) derived from the plugin configuration in
`apps/api/src/auth.ts`. Treat that section as documentation, not as a contract
generated from the running code.

## How it is built

`apps/api/src/openapi/`:

| File         | Role                                                             |
| ------------ | ---------------------------------------------------------------- |
| `schemas.ts` | zod schemas for every request and response shape                  |
| `spec.ts`    | assembles the document via `zod-openapi`'s `createDocument()`     |
| `router.ts`  | serves the JSON and mounts Swagger UI, behind the exposure gate   |

The document is built once at module load and served from memory. Nothing is
generated at build time and no file is written to disk, so there is no
generation step to run and nothing to commit after changing a schema.

Dependencies: `zod-openapi` (zod v4 compatible) and `swagger-ui-express`.

## Keeping it accurate

**The schemas in `openapi/schemas.ts` are hand-mirrored from the zod validators
inside the route modules — they are not the same objects.** Change a validator
in `routes/admin.ts` and the spec will keep describing the old shape without
any error. Typecheck will not catch it. Nothing will.

So when you touch a route's request or response shape, update
`openapi/schemas.ts` in the same change.

The cleaner fix is to export the validators from the route modules and import
them here, making the spec derive from the single source of truth. That was out
of scope when this landed; it is the obvious next step if the duplication
starts to bite.

## Verifying a change

The spec is built at import time, so a broken schema surfaces as soon as the
module loads. To check without booting Mongo and Redis, mount the router on a
bare Express app:

```ts
import express from "express";
import { openApiRouter } from "./src/openapi/router.js";

const app = express();
app.use("/api", openApiRouter);
app.listen(3999, async () => {
  const doc = await (await fetch("http://localhost:3999/api/openapi.json")).json();
  console.log(Object.keys(doc.paths).length, "paths");
});
```

Run it with `node --import tsx <file>` from inside `apps/api`. If the document
has a malformed schema, `createDocument()` throws on import and you never reach
the fetch.

With the full stack running, the same check is just:

```bash
curl -s localhost:3000/api/openapi.json | jq '.paths | keys | length'
```

## Related

- `docs/api-surface.md` — prose reference for the same endpoints, with source
  locations, error codes, rate limits and audit-logging status. Useful when you
  want to know where a handler lives rather than what it accepts.
