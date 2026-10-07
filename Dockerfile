FROM node:24-bookworm-slim

WORKDIR /app
RUN mkdir -p /data && chown node:node /data

COPY --chown=node:node package.json ./
COPY --chown=node:node server/ ./server/
COPY --chown=node:node dist/ ./dist/
COPY --chown=node:node qa/ ./qa/

ENV NODE_ENV=production \
    ORDER_HUB_HOST=0.0.0.0 \
    ORDER_HUB_DB=/data/order-hub.sqlite

USER node
EXPOSE 4180
CMD ["node", "server/index.mjs"]
