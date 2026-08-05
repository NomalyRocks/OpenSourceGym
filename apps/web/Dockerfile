FROM node:22-alpine AS base
RUN corepack enable pnpm

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @opengym/web... --filter @opengym/shared
COPY apps/web apps/web
COPY packages/shared packages/shared
RUN pnpm --filter @opengym/shared build && pnpm --filter @opengym/web build

# The panel is a purely static SPA: it needs no Node at runtime, so nginx is
# enough. That keeps the image small and narrows the attack surface.
FROM nginx:1.29-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
