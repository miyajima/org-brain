import assert from "node:assert/strict";
import test from "node:test";
import { resolvePublishDecision } from "./publish-shared-tarball.mjs";
import {
  sharedPackageSpecs,
  validateTarballContents
} from "./shared-release-tarballs.mjs";

const coreSpec = sharedPackageSpecs.find((spec) => spec.name === "@org-brain/core");
const validCoreManifest = {
  name: "@org-brain/core",
  version: "0.4.0",
  license: "Apache-2.0",
  dependencies: { "@org-brain/contracts": "0.4.0" },
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }
  }
};
const validCoreEntries = [
  "package/LICENSE",
  "package/dist/index.d.ts",
  "package/dist/index.js",
  "package/package.json"
];

test("shared tarball validation accepts exact dependencies and dist exports", () => {
  assert.doesNotThrow(() => validateTarballContents(coreSpec, validCoreManifest, validCoreEntries));
});

test("shared tarball validation rejects workspace dependencies", () => {
  assert.throws(
    () => validateTarballContents(
      coreSpec,
      { ...validCoreManifest, dependencies: { "@org-brain/contracts": "workspace:*" } },
      validCoreEntries
    ),
    /forbidden protocol/u
  );
});

test("shared tarball validation rejects source exports and missing license files", () => {
  assert.throws(
    () => validateTarballContents(
      coreSpec,
      { ...validCoreManifest, exports: { ".": "./src/index.ts" } },
      validCoreEntries
    ),
    /types export must target dist/u
  );
  assert.throws(
    () => validateTarballContents(
      coreSpec,
      validCoreManifest,
      validCoreEntries.filter((entry) => entry !== "package/LICENSE")
    ),
    /missing package\/LICENSE/u
  );
});

test("shared tarball validation rejects unexpected packaged files", () => {
  assert.throws(
    () => validateTarballContents(coreSpec, validCoreManifest, [
      ...validCoreEntries,
      "package/src/index.ts"
    ]),
    /unexpected packaged file/u
  );
});

test("partial npm publish skips only an identical immutable version", () => {
  assert.equal(resolvePublishDecision({
    status: 404,
    localIntegrity: "sha512-local"
  }), "publish");
  assert.equal(resolvePublishDecision({
    status: 200,
    localIntegrity: "sha512-same",
    remoteIntegrity: "sha512-same"
  }), "skip");
  assert.throws(() => resolvePublishDecision({
    status: 200,
    localIntegrity: "sha512-local",
    remoteIntegrity: "sha512-other"
  }), /integrity mismatch/u);
  assert.throws(() => resolvePublishDecision({
    status: 503,
    localIntegrity: "sha512-local"
  }), /HTTP 503/u);
});
