FROM node:26.12.1-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts ./packages/contracts
COPY packages/core ./packages/core
COPY packages/server-core ./packages/server-core
COPY packages/shared ./packages/shared
COPY packages/mcp-core ./packages/mcp-core
COPY packages/orgbrain-cli ./packages/orgbrain-cli
RUN npm install --global pnpm@10.16.1 --ignore-scripts --no-audit --no-fund && \
    pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:26.12.1-bookworm-slim

WORKDIR /app
COPY LICENSE README.md ./
COPY --from=dependencies /app/packages ./packages
COPY --from=dependencies /app/node_modules ./node_modules

RUN mkdir -p /data/backups \
    && chown -R node:node /data \
    && chmod 0700 /data /data/backups \
    && chmod 0755 /app/packages/orgbrain-cli/src/local-memory.mjs

USER node
ENV ORGBRAIN_LOCAL_DB=/data/memory.sqlite
EXPOSE 8788
VOLUME ["/data"]

ENTRYPOINT ["node", "/app/packages/orgbrain-cli/src/local-memory.mjs"]
CMD ["serve", "--host", "127.0.0.1", "--port", "8788"]
