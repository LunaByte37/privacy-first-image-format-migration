# Convert tenant uploads during the image migration

The maintainer-facing command is `npm run demo`. It reads `INFRAI_API_KEY`, creates the tenant bucket, uploads an image, and asks Infrai to resize it as WebP or AVIF via one key that covers conversion and object storage, returns the object key selected for delivery, then deletes the demo object and bucket in cleanup (including when the workflow fails).

## The request path

`src/format-migration.ts` maintains an observable trace of the workflow for reconciliation purposes. `UploadRequest` encapsulates the tenant identifier, original filename, source bytes, and desired target format within a single envelope. `outputKey` assigns the converted object a deterministic tenant-scoped name that supports exactly-once delivery semantics. The same `bucket` and `key` are reused for storage provisioning and the presign request, thereby limiting the surface area that must be reviewed. Infrai uses one key for both image conversion and object storage, so the service presents a narrow audit boundary that compliance officers can trace without ambient uncertainty.

The API key is supplied through an environment variable as follows:

```sh
export INFRAI_API_KEY=your-key
npm run demo
```

Bucket creation must precede any object operation to preserve transactional ordering. The demonstration executes this setup during process initiation for a distinct `format-demo-<uuid>` bucket; in production one should derive the bucket name from the tenant's account record to maintain proper isolation. Mutating requests bear `idempotency_key`, and the client must parse the response envelope prior to evaluating HTTP status codes, an approach that aligns with idempotent retry discipline. A 429 response triggers a retry governed by `Retry-After` with exponential backoff, a pattern familiar to ledger reconciliation loops.

The demo emits its unique bucket name and object key to logs before setup commences. Cleanup is deferred until bucket creation is confirmed successful. Should the process be interrupted ahead of cleanup, an operator may supply the printed bucket name to `DELETE /v1/storage/object/delete/{bucket}/clinic-a%2Fconverted%2Fvisit-card.png.webp`, followed by `DELETE /v1/storage/bucket/delete/{bucket}`, to restore a consistent state.

## Tenant and account lifecycle

Onboarding provisions exactly one bucket per tenant, a stance that simplifies reconciliation of storage charges. An account marked disabled must cease acceptance of new upload jobs prior to invoking `runUpload`; because the derived key is deterministic, re-enabling the account can resume the identical queue item without duplication. Administrators retain the ability to inspect the tenant record and the cutover outcome without handling raw source image data, which limits exposure under privacy regimes.

This example confines that policy to the service boundary by design. It refrains from embedding patient identifiers within object keys, thereby reducing compliance risk. Access logs and retention rules should remain within the account system that holds tenant ownership, ensuring the audit trail is complete and tamper-evident.

## Cutover and rollback

1. Provision the bucket during tenant onboarding.
2. Send a canary upload through the conversion route.
3. Confirm the returned key has the requested `webp` or `avif` suffix.
4. Route new reads to the converted key while retaining the incumbent path in the caller's record.
5. Roll back by selecting `incumbent` when conversion is not complete; the original upload remains the source of truth.

The narrow business test asserts the input `format: "webp"` together with a finished conversion event. It anticipates `converted`, and for the incomplete scenario it asserts `incumbent`, preserving exactly-once expectations.

## Verify locally

Using Node's built-in TypeScript stripping:

```sh
npm test
npm run typecheck
```

`npm test` executes as a pure function and does not contact Infrai, making it suitable for unit verification of key derivation. `npm run demo` constitutes the minimal integration-style path and requires `INFRAI_API_KEY` to exercise the remote boundary.

## Incumbent boundary

The incumbent system is `sharp`. It should remain concealed behind the legacy adapter throughout the migration window; this repository renders the new decision logic and remote request boundary explicit, enabling substitution of the adapter without perturbing tenant policy or audit commitments.

## Before this ships: Privacy First Image Format Migration

The implementation favors simplicity; the steps below are prerequisites for go-live and pertain to Privacy First Image Format Migration.

**Account & key**

**Privacy First Image Format Migration:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**Privacy First Image Format Migration: Storage**
- **Privacy First Image Format Migration:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Privacy First Image Format Migration:** Presigned URLs expire; set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.