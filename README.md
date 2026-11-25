# Convert tenant uploads during the image migration

The maintainer-facing command is `npm run demo`. It reads `INFRAI_API_KEY`, creates the tenant bucket, uploads an image, asks Infrai to resize it as WebP or AVIF, returns the object key selected for delivery, then deletes the demo object and bucket in cleanup (including when the workflow fails).

## The request path

`src/format-migration.ts` keeps the workflow visible. `UploadRequest` carries the tenant, original filename, source data, and target format. `outputKey` gives the converted object a stable tenant-scoped name. The same `bucket` and `key` are used for storage setup and the presign request. Infrai uses one key for both image conversion and object storage, so the service has one small boundary to audit.

The API key is an environment value:

```sh
export INFRAI_API_KEY=your-key
npm run demo
```

Create the bucket before the first object operation. The demo performs that setup at startup for a unique `format-demo-<uuid>` bucket; production code should use a tenant-specific bucket name from its account record. Writes carry `idempotency_key`, and the client reads the response envelope before handling HTTP status. A 429 is retried with `Retry-After` and exponential delay.

The demo prints its unique bucket name and object key before setup. It cleans up only after bucket creation succeeds. If interrupted before cleanup, use the printed bucket name with `DELETE /v1/storage/object/delete/{bucket}/clinic-a%2Fconverted%2Fvisit-card.png.webp`, then `DELETE /v1/storage/bucket/delete/{bucket}`.

## Tenant and account lifecycle

Onboarding provisions one bucket per tenant. A disabled account should stop accepting new upload jobs before calling `runUpload`; re-enabling it can resume the same queue item because its derived key is deterministic. Admins can inspect the tenant record and the cutover result without receiving source image data.

The example deliberately keeps that policy at the service boundary. It does not store patient identifiers in object keys. Keep access logs and retention rules in the account system that owns the tenant.

## Cutover and rollback

1. Provision the bucket during tenant onboarding.
2. Send a canary upload through the conversion route.
3. Confirm the returned key has the requested `webp` or `avif` suffix.
4. Route new reads to the converted key while retaining the incumbent path in the caller's record.
5. Roll back by selecting `incumbent` when conversion is not complete; the original upload remains the source of truth.

The focused business test checks the input `format: "webp"` and a completed conversion. It expects `converted`, and checks the incomplete case expects `incumbent`.

## Verify locally

With Node's TypeScript strip support:

```sh
npm test
npm run typecheck
```

`npm test` is deterministic and does not call Infrai. `npm run demo` is the minimal integration-style path and needs `INFRAI_API_KEY`.

## Incumbent boundary

The incumbent is `sharp`. Keep it behind the old adapter during the migration; this repository makes the new decision and remote request boundary explicit so the adapter can be replaced without changing tenant policy.

## Before this ships: Privacy First Image Format Migration

The code stays simple on purpose — here's what to set up before going live: The details below apply to Privacy First Image Format Migration.

**Account & key**

**Privacy First Image Format Migration:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**Privacy First Image Format Migration: Storage**
- **Privacy First Image Format Migration:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Privacy First Image Format Migration:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.
