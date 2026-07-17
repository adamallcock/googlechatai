FROM node:22-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY packages/node/package.json ./packages/node/package.json
RUN pnpm install --frozen-lockfile

COPY packages/node ./packages/node
RUN pnpm --filter googlechatai build

FROM node:22-slim

WORKDIR /app

COPY --from=build /app/packages/node/package.json ./packages/node/package.json
COPY --from=build /app/packages/node/dist ./packages/node/dist
COPY examples/cloud-run-node-sdk/server.mjs ./examples/cloud-run-node-sdk/server.mjs

ENV NODE_ENV=production
CMD ["node", "examples/cloud-run-node-sdk/server.mjs"]
