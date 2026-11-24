import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// The credential resolution chain from src/lib/aws/config.ts against a real
// (in-memory) database for the stored-settings branch, with the ECS container
// metadata endpoint and fetch failures mocked at the network boundary.
const { app, newDatabase } = await loadApp("aws-credentials", `export * from "./src/lib/aws/config.ts";`);

function mockMetadata(handler) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input) => {
		const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
		calls.push(url.href);
		const result = handler(url);
		return new Response(JSON.stringify(result.body ?? {}), { status: result.status ?? 200 });
	};
	return { calls, restore: () => { globalThis.fetch = original; } };
}

const ecsBody = (keyId, expirationFromNowMs) => ({
	AccessKeyId: keyId,
	SecretAccessKey: "task-secret",
	Token: "task-token",
	Expiration: new Date(Date.now() + expirationFromNowMs).toISOString(),
});

test("stored settings win over environment credentials so admin-saved keys keep working", async (t) => {
	const { env } = await newDatabase(t);
	await app.saveAwsConfig(env, { accessKeyId: "AKISTORED", secretAccessKey: "stored-secret", region: "eu-west-1" }, "111122223333");
	const withEnv = { ...env, AWS_ACCESS_KEY_ID: "AKIENV", AWS_SECRET_ACCESS_KEY: "env-secret", AWS_REGION: "us-east-1" };
	assert.deepEqual(await app.resolveAwsCredentials(withEnv), { accessKeyId: "AKISTORED", secretAccessKey: "stored-secret", region: "eu-west-1" });
	assert.equal((await app.getAwsConfigStatus(withEnv)).source, "settings");
});

test("environment credentials resolve with the session token attached", async (t) => {
	const { env } = await newDatabase(t);
	const withEnv = { ...env, AWS_ACCESS_KEY_ID: "AKIENV", AWS_SECRET_ACCESS_KEY: "env-secret", AWS_REGION: "us-east-1", AWS_SESSION_TOKEN: "tok-1" };
	assert.deepEqual(await app.resolveAwsCredentials(withEnv), { accessKeyId: "AKIENV", secretAccessKey: "env-secret", region: "us-east-1", sessionToken: "tok-1" });
	assert.equal((await app.getAwsConfigStatus(withEnv)).source, "environment");
});

test("the region falls back to AWS_DEFAULT_REGION and AWS_REGION wins when both are set", async (t) => {
	const { env } = await newDatabase(t);
	const keys = { AWS_ACCESS_KEY_ID: "AKIENV", AWS_SECRET_ACCESS_KEY: "env-secret" };
	assert.equal((await app.getAwsConfig({ ...env, ...keys, AWS_DEFAULT_REGION: "eu-west-2" }))?.region, "eu-west-2");
	assert.equal((await app.getAwsConfig({ ...env, ...keys, AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "eu-west-2" }))?.region, "us-east-1");
});

test("no credentials anywhere resolve to null without any network call", async (t) => {
	const mock = mockMetadata(() => ({ body: {} }));
	try {
		const { env } = await newDatabase(t);
		assert.equal(await app.getAwsConfig(env), null);
		assert.equal(await app.resolveAwsCredentials(env), null);
		assert.deepEqual(mock.calls, []);
	} finally { mock.restore(); }
});

test("ECS container metadata resolves credentials when only the relative URI and a region are set", async (t) => {
	const uri = "/v2/creds/found";
	const mock = mockMetadata(() => ({ body: ecsBody("AKITASK", 3_600_000) }));
	try {
		const { env } = await newDatabase(t);
		const withEnv = { ...env, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: uri, AWS_REGION: "us-east-1" };
		assert.deepEqual(await app.getAwsConfig(withEnv), { accessKeyId: "AKITASK", secretAccessKey: "task-secret", region: "us-east-1", sessionToken: "task-token" });
		assert.deepEqual(mock.calls, [`http://169.254.170.2${uri}`]);
		const status = await app.getAwsConfigStatus(withEnv);
		assert.equal(status.configured, true);
		assert.equal(status.source, "iam-role");
	} finally { mock.restore(); }
});

test("metadata credentials are cached per URI and served without a second fetch", async (t) => {
	const first = "/v2/creds/cache-a";
	const second = "/v2/creds/cache-b";
	const mock = mockMetadata(() => ({ body: ecsBody("AKITASK", 3_600_000) }));
	try {
		const { env } = await newDatabase(t);
		const envA = { ...env, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: first, AWS_REGION: "us-east-1" };
		const envB = { ...env, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: second, AWS_REGION: "us-east-1" };
		assert.equal((await app.getAwsConfig(envA)).accessKeyId, "AKITASK");
		assert.equal((await app.getAwsConfig(envA)).accessKeyId, "AKITASK");
		assert.equal(mock.calls.length, 1, "the same URI is served from the cache");
		assert.equal((await app.getAwsConfig(envB)).accessKeyId, "AKITASK");
		assert.equal(mock.calls.length, 2, "a different URI is fetched separately");
		assert.equal((await app.getAwsConfig(envA)).accessKeyId, "AKITASK");
		assert.equal(mock.calls.length, 2);
	} finally { mock.restore(); }
});

test("credentials within five minutes of expiry are refreshed and the stale cache is never served", async (t) => {
	const uri = "/v2/creds/refresh";
	let expiration = 4 * 60_000;
	let keyId = "AKISOON1";
	const mock = mockMetadata(() => ({ body: ecsBody(keyId, expiration) }));
	try {
		const { env } = await newDatabase(t);
		const withEnv = { ...env, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: uri, AWS_REGION: "us-east-1" };
		assert.equal((await app.getAwsConfig(withEnv)).accessKeyId, "AKISOON1");
		keyId = "AKIFRESH";
		expiration = 3_600_000;
		assert.equal((await app.getAwsConfig(withEnv)).accessKeyId, "AKIFRESH", "near-expiry credentials are re-fetched, not served stale");
		assert.equal(mock.calls.length, 2);
	} finally { mock.restore(); }
});

test("a failed metadata request resolves to null instead of throwing", async (t) => {
	const mock = mockMetadata(() => ({ status: 500 }));
	try {
		const { env } = await newDatabase(t);
		const withEnv = { ...env, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds/fail", AWS_REGION: "us-east-1" };
		assert.equal(await app.getAwsConfig(withEnv), null);
		assert.equal(await app.resolveAwsCredentials(withEnv), null);
	} finally { mock.restore(); }
});

test("a rejected metadata fetch also resolves to null instead of throwing", async (t) => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("link-local unreachable"); };
	try {
		const { env } = await newDatabase(t);
		const withEnv = { ...env, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds/reject", AWS_REGION: "us-east-1" };
		assert.equal(await app.getAwsConfig(withEnv), null);
	} finally { globalThis.fetch = original; }
});

test("static environment credentials win over the container metadata endpoint", async (t) => {
	const mock = mockMetadata(() => ({ body: ecsBody("AKITASK", 3_600_000) }));
	try {
		const { env } = await newDatabase(t);
		const withEnv = {
			...env,
			AWS_ACCESS_KEY_ID: "AKIENV", AWS_SECRET_ACCESS_KEY: "env-secret", AWS_REGION: "us-east-1",
			AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds/env-wins",
		};
		assert.deepEqual(await app.resolveAwsCredentials(withEnv), { accessKeyId: "AKIENV", secretAccessKey: "env-secret", region: "us-east-1" });
		assert.deepEqual(mock.calls, [], "the metadata endpoint is never contacted when static keys exist");
	} finally { mock.restore(); }
});
