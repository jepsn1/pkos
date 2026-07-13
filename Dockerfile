# API container (mirrors biblestdy). Single stage; slim later if size bites.
FROM node:22-alpine

# git: api commits knowledge-vault writes (vault mounted at /vault, see compose)
RUN apk add --no-cache git && corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @pkos/api --filter @pkos/shared

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @pkos/shared build && pnpm --filter @pkos/api build

ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "apps/api/dist/main.js"]
