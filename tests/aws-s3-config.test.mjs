import assert from "node:assert/strict";
import test from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

// getS3Config/describeB2Problem from src/lib/storage/b2-config.ts. The AWS
// credential resolver is mocked so the provider contract (lazy, delegating to
// getAwsConfig) is tested without a database.
const fixture = await loadFixture({
	name: "aws-s3-config",
	entryPoint: "src/lib/storage/b2-config.ts",
	mocks: {
		"@/lib/aws/config": `
			// Read the state object per call (not captured at module-eval time):
			// the tests' reset() installs a fresh object, and the mock must
			// always observe the current one (the fixtures.mjs indirection pattern).
			export async function getAwsConfig(env) {
				const state = (globalThis.__s3config = globalThis.__s3config ?? { calls: 0, result: null });
				state.calls += 1;
				return state.result;
			}
		`,
	},
});
const b2config = await fixture.import();
const state = () => globalThis.__s3config;
const reset = (result) => { globalThis.__s3config = { calls: 0, result }; };
test.after(() => fixture.dispose());

test("static S3 credentials keep returning the unchanged config", () => {
	reset(null);
	const config = b2config.getS3Config({ S3_BUCKET: "bkt", S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: "AKI", S3_SECRET_ACCESS_KEY: "sec" });
	assert.deepEqual(config, { keyId: "AKI", applicationKey: "sec", bucket: "bkt", region: "us-east-1", endpoint: "s3.us-east-1.amazonaws.com" });
	assert.equal("credentialsProvider" in config, false);
	assert.equal(state().calls, 0, "no credential resolution happens on the static path");
});

test("S3 with a session token but no static keys returns a provider-backed config, resolved lazily", () => {
	reset(null);
	const config = b2config.getS3Config({ S3_BUCKET: "bkt", S3_REGION: "us-east-1", AWS_SESSION_TOKEN: "tok" });
	assert.ok(config, "provider-backed S3 config is returned");
	assert.equal(config.bucket, "bkt");
	assert.equal(config.region, "us-east-1");
	assert.equal(config.endpoint, "s3.us-east-1.amazonaws.com");
	assert.equal(typeof config.credentialsProvider, "function");
	assert.equal(state().calls, 0, "the provider is lazy: wrapping the env reads no credentials");
});

test("S3 with only the ECS container URI returns the same provider-backed config", () => {
	reset(null);
	const config = b2config.getS3Config({ S3_BUCKET: "bkt", S3_REGION: "us-east-1", AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds" });
	assert.ok(config);
	assert.equal(typeof config.credentialsProvider, "function");
	assert.equal(state().calls, 0);
});

test("the credentialsProvider resolves through getAwsConfig", async () => {
	reset({ accessKeyId: "AKITASK", secretAccessKey: "task-secret", region: "us-east-1", sessionToken: "task-token" });
	const config = b2config.getS3Config({ S3_BUCKET: "bkt", S3_REGION: "us-east-1", AWS_SESSION_TOKEN: "tok" });
	const resolved = await config.credentialsProvider();
	assert.equal(state().calls, 1);
	assert.deepEqual(resolved, { accessKeyId: "AKITASK", secretAccessKey: "task-secret", region: "us-east-1", sessionToken: "task-token" });
});

test("the credentialsProvider rejects when AWS is not configured", async () => {
	reset(null);
	const config = b2config.getS3Config({ S3_BUCKET: "bkt", S3_REGION: "us-east-1", AWS_SESSION_TOKEN: "tok" });
	await assert.rejects(() => config.credentialsProvider(), /credential/i);
});

test("half-configured S3 still returns null", () => {
	reset(null);
	assert.equal(b2config.getS3Config({ S3_BUCKET: "bkt", AWS_SESSION_TOKEN: "tok" }), null, "a bucket without a region is not S3");
	assert.equal(b2config.getS3Config({ S3_BUCKET: "bkt", S3_REGION: "us-east-1" }), null, "no keys and no task-role hint is not S3");
	assert.equal(b2config.getS3Config({ S3_BUCKET: "bkt", S3_REGION: "mars-1", AWS_SESSION_TOKEN: "tok" }), null, "an invalid region is not S3");
});

test("Backblaze B2 still needs all four static variables and wins over S3", () => {
	reset(null);
	const b2Env = { B2_KEY_ID: "k", B2_APPLICATION_KEY: "a", B2_BUCKET: "b", B2_ENDPOINT: "s3.us-west-004.backblazeb2.com" };
	assert.deepEqual(
		b2config.getB2Config(b2Env),
		{ keyId: "k", applicationKey: "a", bucket: "b", endpoint: "s3.us-west-004.backblazeb2.com", region: "us-west-004" },
	);
	assert.equal(b2config.getB2Config({ B2_KEY_ID: "k", B2_APPLICATION_KEY: "a", B2_BUCKET: "b" }), null, "B2 without an endpoint is still null");
	const both = b2config.getObjectStorageConfig({ ...b2Env, S3_BUCKET: "sbkt", S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: "k2", S3_SECRET_ACCESS_KEY: "a2" });
	assert.equal(both.provider, "backblaze", "Backblaze wins when both are configured");
});

test("describeB2Problem names the task-role option for a half-configured S3 setup", () => {
	reset(null);
	const problem = b2config.describeB2Problem({ S3_BUCKET: "bkt", S3_REGION: "us-east-1" });
	assert.ok(problem, "a half-configured S3 setup is still diagnosed");
	assert.match(problem, /AWS_CONTAINER_CREDENTIALS_RELATIVE_URI|task role|task-role/i);
});
