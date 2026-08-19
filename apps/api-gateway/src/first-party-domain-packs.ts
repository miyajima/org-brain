import { domainPackManifestSchema, type DomainPackManifestV1 } from "@org-brain/contracts";
import buildEngineering from "../../../domain-packs/first-party/build-engineering/manifest.json";
import pdmB2c from "../../../domain-packs/first-party/pdm-b2c/manifest.json";
import sales from "../../../domain-packs/first-party/sales/manifest.json";
import sre from "../../../domain-packs/first-party/sre/manifest.json";

export const FIRST_PARTY_DOMAIN_PACKS: DomainPackManifestV1[] = [
  buildEngineering,
  sre,
  sales,
  pdmB2c
].map((manifest) => domainPackManifestSchema.parse(manifest));

