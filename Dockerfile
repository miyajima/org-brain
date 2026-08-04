FROM node:22.13-bookworm-slim

WORKDIR /app
COPY LICENSE README.md ./
COPY packages/orgbrain-cli ./packages/orgbrain-cli

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
