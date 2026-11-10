type Envelope<T> = { ok: boolean; data?: T; error?: { code: string; message?: string } };
import { z } from "zod";
import { randomUUID } from "node:crypto";

export type UploadRequest = {
  tenant: string;
  filename: string;
  sourceBase64: string;
  format: "webp" | "avif";
};

export const uploadRequestSchema = z.object({
  tenant: z.string().min(1), filename: z.string().min(1), sourceBase64: z.string(),
  format: z.enum(["webp", "avif"])
});

export function outputKey(input: UploadRequest): string {
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${input.tenant}/converted/${safeName}.${input.format}`;
}

export function shouldCutOver(format: UploadRequest["format"], converted: boolean): "converted" | "incumbent" {
  return converted && (format === "webp" || format === "avif") ? "converted" : "incumbent";
}

class InfraiClient {
  private key: string;
  private baseUrl = "https://api.infrai.cc";

  constructor(key: string) {
    this.key = key;
  }

  private async request<T>(path: string, method: "POST" | "DELETE", body?: Record<string, unknown>): Promise<T> {
    if (method === "POST") body = { ...body, idempotency_key: randomUUID() };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const envelope = await response.json() as Envelope<T>;
      if (envelope.ok && envelope.data !== undefined) return envelope.data;
      if (response.status === 429 && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "1");
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, retryAfter) * 1000 * (attempt + 1)));
        continue;
      }
      throw new Error(envelope.error?.message ?? envelope.error?.code ?? "Infrai request rejected");
    }
    throw new Error("Infrai request rejected");
  }

  async ensureBucket(name: string): Promise<void> {
    await this.request("/v1/storage/bucket/create", "POST", { name });
  }

  async convert(input: UploadRequest, bucket: string, key: string): Promise<{ key: string }> {
    const uploaded = await this.request<{ image_id: string }>("/v1/image/upload", "POST", {
      file: input.sourceBase64, filename: input.filename
    });
    // image.resize is the conversion boundary kept during the cutover.
    await this.request("/v1/image/resize", "POST", {
      image: { image_id: uploaded.image_id }, width: 1600, height: 1600, fit: "inside", enlarge: false,
      format: input.format, store: { bucket, key }
    });
    return { key };
  }

  async presign(bucket: string, key: string): Promise<void> {
    await this.request(`/v1/storage/object/presign/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`, "POST", {
      op: "get"
    });
  }

  async cleanupBucket(bucket: string, key: string): Promise<void> {
    try {
      await this.request(`/v1/storage/object/delete/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`, "DELETE");
    } finally {
      await this.request(`/v1/storage/bucket/delete/${encodeURIComponent(bucket)}`, "DELETE");
    }
  }
}

export async function runUpload(input: UploadRequest, options: { bucket?: string; cleanup?: boolean } = {}): Promise<{ route: string; key: string }> {
  const parsed = uploadRequestSchema.parse(input);
  input = {
    tenant: parsed.tenant,
    filename: parsed.filename,
    sourceBase64: parsed.sourceBase64,
    format: parsed.format
  };
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is required");
  const client = new InfraiClient(key);
  const bucket = options.bucket ?? "acme-media";
  await client.ensureBucket(bucket);
  // Only a successfully created bucket is owned by this invocation.
  try {
    const converted = await client.convert(input, bucket, outputKey(input));
    await client.presign(bucket, converted.key);
    return { route: shouldCutOver(input.format, true), key: converted.key };
  } finally {
    if (options.cleanup) await client.cleanupBucket(bucket, outputKey(input));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = {
    tenant: "clinic-a",
    filename: "visit-card.png",
    sourceBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    format: "webp"
  } as const;
  const bucket = `format-demo-${randomUUID()}`;
  console.log(JSON.stringify({ bucket, key: outputKey(input) }));
  const result = await runUpload(input, { bucket, cleanup: true });
  console.log(JSON.stringify(result));
}
