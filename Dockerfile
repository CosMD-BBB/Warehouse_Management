# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

WORKDIR /app
RUN mkdir -p /data && chown node:node /data

COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --ignore-scripts --no-audit --no-fund; \
    else \
      npm ci --ignore-scripts --no-audit --no-fund; \
    fi
COPY --chown=node:node server/ ./server/
COPY --chown=node:node dist/ ./dist/
COPY --chown=node:node qa/ ./qa/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node .devcontainer/ ./.devcontainer/
COPY --chown=node:node api/ ./api/
COPY --chown=node:node vercel.json ./

ENV NODE_ENV=production \
    ORDER_HUB_HOST=0.0.0.0 \
    ORDER_HUB_DB=/data/order-hub.sqlite

USER node
EXPOSE 4180
CMD ["node", "server/index.mjs"]
