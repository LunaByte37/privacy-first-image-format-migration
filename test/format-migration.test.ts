import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { outputKey, shouldCutOver } from "../src/format-migration.ts";

test("a completed WebP conversion selects the converted object", () => {
  const input = { tenant: "clinic-a", filename: "patient card.jpg", sourceBase64: "", format: "webp" as const };
  assert.equal(outputKey(input), "clinic-a/converted/patient-card.jpg.webp");
  assert.equal(shouldCutOver(input.format, true), "converted");
  assert.equal(shouldCutOver(input.format, false), "incumbent");
});

for (const failObjectDelete of [false, true]) {
  test(`demo binds the converted object to delivery and cleans up (delete failure: ${failObjectDelete})`, () => {
    const entry = new URL("../src/format-migration.ts", import.meta.url);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { fileURLToPath } from 'node:url';
      const calls = [];
      globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname;
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ path, body });
        if (options.method === 'POST') assert.equal(typeof body.idempotency_key, 'string');
        const bucket = calls[0].body.name;
        assert.match(bucket, /^format-demo-/);
        if (path.endsWith('/image/resize')) {
          assert.deepEqual(body.store, { bucket, key: 'clinic-a/converted/visit-card.png.webp' });
        }
        if (path.includes('/object/presign/')) {
          assert.ok(calls.some(c => c.path.endsWith('/image/resize')));
          assert.equal(path, '/v1/storage/object/presign/' + bucket + '/clinic-a%2Fconverted%2Fvisit-card.png.webp');
        }
        if (${failObjectDelete} && path.includes('/object/delete/')) {
          return Response.json({ ok: false, error: { message: 'object delete failed' } });
        }
        return Response.json({ ok: true, data: path.endsWith('/image/upload') ? { image_id: 'test-image' } : {} });
      };
      process.argv[1] = fileURLToPath(${JSON.stringify(entry.href)});
      let failure;
      try { await import(${JSON.stringify(entry.href)}); } catch (error) { failure = error; }
      assert.equal(failure?.message, ${failObjectDelete ? "'object delete failed'" : "undefined"});
      assert.equal(calls.at(-2).path, '/v1/storage/object/delete/' + calls[0].body.name + '/clinic-a%2Fconverted%2Fvisit-card.png.webp');
      assert.equal(calls.at(-1).path, '/v1/storage/bucket/delete/' + calls[0].body.name);
    `], { env: { ...process.env, INFRAI_API_KEY: "local-test-key" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
}

test("failed bucket creation never deletes existing resources", () => {
  const entry = new URL("../src/format-migration.ts", import.meta.url);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push(options.method);
      return Response.json({ ok: false, error: { message: 'already exists' } });
    };
    const { runUpload } = await import(${JSON.stringify(entry.href)});
    await assert.rejects(runUpload({ tenant: 'test', filename: 'a.png', sourceBase64: '', format: 'webp' },
      { bucket: 'existing', cleanup: true }), /already exists/);
    assert.deepEqual(calls, ['POST']);
  `], { env: { ...process.env, INFRAI_API_KEY: "local-test-key" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
