// Node test shim for the pinned provider's handler type check and empty env. OAuth,
// crypto, grant storage and HTTP handlers execute the actual provider source.
// This is not a Workers runtime or live Cloudflare authentication test.
export class WorkerEntrypoint {}
export const env = {};
