FROM node:22.13-bookworm-slim

WORKDIR /app
COPY package.json LICENSE README.md ./
COPY scripts/local-memory.mjs ./scripts/local-memory.mjs
COPY scripts/local-mcp.mjs ./scripts/local-mcp.mjs
COPY scripts/hook-memory-bridge.mjs ./scripts/hook-memory-bridge.mjs
COPY scripts/lib/local-memory-store.mjs ./scripts/lib/local-memory-store.mjs
COPY scripts/lib/memory-mode.mjs ./scripts/lib/memory-mode.mjs
COPY scripts/lib/memory-quality.mjs ./scripts/lib/memory-quality.mjs

RUN mkdir -p /data/backups \
    && chown -R node:node /data \
    && chmod 0700 /data /data/backups \
    && chmod 0755 /app/scripts/local-memory.mjs

USER node
ENV ORGBRAIN_LOCAL_DB=/data/memory.sqlite
EXPOSE 8788
VOLUME ["/data"]

ENTRYPOINT ["node", "/app/scripts/local-memory.mjs"]
CMD ["serve", "--host", "127.0.0.1", "--port", "8788"]
