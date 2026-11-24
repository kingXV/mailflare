import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-s3-bucket-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const bucketMod = await bundle("src/lib/storage/b2-bucket.ts", "b2-bucket.mjs");

function mockFetch() {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
		calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
		return new Response(null, { status: 200, headers: { etag: '"etag-1"', "last-modified": new Date(0).toUTCString() } });
	};
	return { calls, restore: () => { globalThis.fetch = original; } };
}

const staticConfig = { keyId: "static-key", applicationKey: "static-secret", region: "us-east-1", bucket: "bkt", endpoint: "s3.us-east-1.amazonaws.com" };

test("credentialsProvider is called once per request and its keys are the ones signed", async () => {
	const mock = mockFetch();
	try {
		let providerCalls = 0;
		const bucket = new bucketMod.B2Bucket({
			...staticConfig,
			credentialsProvider: async () => { providerCalls += 1; return { accessKeyId: "AKIPROVIDER", secretAccessKey: "provider-secret", region: "us-east-1" }; },
		});
		await bucket.head("a.txt");
		await bucket.head("b.txt");
		assert.equal(providerCalls, 2, "credentials are resolved per request, not frozen at construction");
		assert.equal(mock.calls.length, 2);
		assert.match(mock.calls[0].headers.Authorization, /Credential=AKIPROVIDER\//);
		assert.match(mock.calls[1].headers.Authorization, /Credential=AKIPROVIDER\//);
	} finally { mock.restore(); }
});

test("the provider's session token is passed through to the signer", async () => {
	const mock = mockFetch();
	try {
		const bucket = new bucketMod.B2Bucket({
			...staticConfig,
			credentialsProvider: async () => ({ accessKeyId: "AKIPROVIDER", secretAccessKey: "provider-secret", region: "us-east-1", sessionToken: "tok-session" }),
		});
		await bucket.head("a.txt");
		assert.equal(mock.calls[0].headers["x-amz-security-token"], "tok-session");
	} finally { mock.restore(); }
});

test("a static config without a provider keeps building its credentials from the keys", async () => {
	const mock = mockFetch();
	try {
		const bucket = new bucketMod.B2Bucket(staticConfig);
		const object = await bucket.head("a.txt");
		assert.ok(object, "the request still succeeds");
		assert.match(mock.calls[0].headers.Authorization, /Credential=static-key\//);
		assert.equal("x-amz-security-token" in mock.calls[0].headers, false);
	} finally { mock.restore(); }
});

test("a failing credentialsProvider propagates instead of falling back to static keys", async () => {
	const mock = mockFetch();
	try {
		const bucket = new bucketMod.B2Bucket({
			...staticConfig,
			credentialsProvider: async () => { throw new Error("task role expired"); },
		});
		await assert.rejects(() => bucket.head("a.txt"), /task role expired/);
		assert.deepEqual(mock.calls, [], "no request is signed with fallback credentials");
	} finally { mock.restore(); }
});
