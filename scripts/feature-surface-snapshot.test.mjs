import assert from "node:assert/strict";
import test from "node:test";
import { collectApiRoutes } from "./feature-surface-snapshot.mjs";

test("records literal routes including Hono path parameters", () => {
  const routes = collectApiRoutes("routes.ts", `
    app.get("/v1/team-knowledge/item/:id" as const, handler);
    routes.post('/v1/tasks', handler);
  `);
  assert.deepEqual(routes, ["GET /v1/team-knowledge/item/:id", "POST /v1/tasks"]);
});

test("rejects interpolated paths instead of recording an unexpanded placeholder", () => {
  assert.throws(() => collectApiRoutes("routes.ts", `
    const root = "/v1/team-knowledge";
    app.get(\`\${root}/status\`, handler);
  `), /Use a literal route path in routes\.ts/);
});
