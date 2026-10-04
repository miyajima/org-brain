// Node test shim for the pinned provider's handler type check only. OAuth,
// crypto, grant storage and HTTP handlers execute the actual provider source.
// This is not a Workers runtime or live Cloudflare authentication test.
export class WorkerEntrypoint {}
