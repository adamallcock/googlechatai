FROM node:26-slim

WORKDIR /app
COPY package.json server.mjs ./

ENV NODE_ENV=production
CMD ["node", "server.mjs"]
