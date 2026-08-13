const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3-embedding:0.6b";
const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function isLoopbackEndpoint(endpoint) {
  const url = new URL(endpoint);
  return url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
}

function normalizedEndpoint(value) {
  const endpoint = String(value || DEFAULT_ENDPOINT).replace(/\/+$/u, "");
  if (!isLoopbackEndpoint(endpoint)) {
    throw new Error("local_embedding_endpoint_must_be_loopback");
  }
  return endpoint;
}

function validateVector(vector, dimensions) {
  if (
    !Array.isArray(vector) ||
    vector.length !== dimensions ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("local_embedding_invalid_vector");
  }
  return vector;
}

export class OllamaEmbeddingProvider {
  constructor(options = {}) {
    this.endpoint = normalizedEndpoint(options.endpoint);
    this.model = String(options.model || DEFAULT_MODEL);
    this.dimensions = Number(options.dimensions || DEFAULT_DIMENSIONS);
    this.timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    this.provider = `ollama:${this.model}`;
    if (!Number.isInteger(this.dimensions) || this.dimensions < 32 || this.dimensions > 4096) {
      throw new Error("local_embedding_invalid_dimensions");
    }
  }

  async embedDocuments(texts) {
    return this.#embed(texts.map((text) => String(text).slice(0, 4_000)));
  }

  async embedQuery(text) {
    const instruction = [
      "Instruct: Retrieve the durable software-engineering lesson that best helps with the next task.",
      `Query: ${String(text).slice(0, 4_000)}`
    ].join("\n");
    return (await this.#embed([instruction]))[0];
  }

  async #embed(input) {
    if (!Array.isArray(input) || input.length === 0) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(`${this.endpoint}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input,
          dimensions: this.dimensions,
          truncate: true,
          keep_alive: "5m"
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`local_embedding_provider_http_${response.status}`);
      }
      const body = await response.json();
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) {
        throw new Error("local_embedding_invalid_response");
      }
      return body.embeddings.map((vector) => validateVector(vector, this.dimensions));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("local_embedding_")) throw error;
      throw new Error("local_embedding_provider_unavailable", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function localDenseEmbeddingProviderFromEnvironment(env = process.env) {
  const provider = String(env.ORGBRAIN_LOCAL_EMBEDDING_PROVIDER || "").trim().toLowerCase();
  if (!provider || provider === "sparse" || provider === "off") return null;
  if (provider !== "qwen-ollama") throw new Error("local_embedding_unknown_provider");
  return new OllamaEmbeddingProvider({
    endpoint: env.ORGBRAIN_LOCAL_EMBEDDING_URL,
    model: env.ORGBRAIN_LOCAL_EMBEDDING_MODEL,
    dimensions: env.ORGBRAIN_LOCAL_EMBEDDING_DIMENSIONS,
    timeoutMs: env.ORGBRAIN_LOCAL_EMBEDDING_TIMEOUT_MS
  });
}

export function encodeFloat32Vector(vector) {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT));
  return buffer;
}

export function decodeFloat32Vector(value, expectedDimensions = null) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  if (buffer.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("local_embedding_corrupt_vector");
  }
  const dimensions = buffer.length / Float32Array.BYTES_PER_ELEMENT;
  if (expectedDimensions !== null && dimensions !== expectedDimensions) {
    throw new Error("local_embedding_dimension_mismatch");
  }
  return Array.from({ length: dimensions }, (_, index) =>
    buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT)
  );
}

export function cosineSimilarity(left, right) {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator > 0 ? dot / denominator : 0;
}
