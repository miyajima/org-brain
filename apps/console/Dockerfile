FROM node:22.13-alpine AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/console/package.json apps/console/package.json
RUN pnpm install --frozen-lockfile --filter @org-brain/console...
COPY apps/console apps/console
RUN pnpm --filter @org-brain/console build:node

FROM node:22.13-alpine
ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/apps/console/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server/entry.mjs"]
