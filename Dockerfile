FROM node:22-slim

WORKDIR /app
COPY tools/cloud/idempotency-monitor.mjs ./tools/cloud/idempotency-monitor.mjs

ENV NODE_ENV=production
CMD ["node", "tools/cloud/idempotency-monitor.mjs"]
