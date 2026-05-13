# syntax=docker/dockerfile:1.7
# Multi-stage build: deps → build → slim runtime
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/evm/package.json ./packages/evm/
COPY packages/facilitator/package.json ./packages/facilitator/
COPY packages/client/package.json ./packages/client/
COPY packages/mcp/package.json ./packages/mcp/
COPY apps/server/package.json ./apps/server/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.1 --activate
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
RUN pnpm install --prod --frozen-lockfile && \
    pnpm store prune && \
    rm -rf /root/.local/share/pnpm/store

EXPOSE 8402
USER node
CMD ["node", "apps/server/dist/main.js"]
