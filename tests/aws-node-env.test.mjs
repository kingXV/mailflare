import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// createNodeRuntime selecting SQS-backed queues and passing the task-role
// credential variables through. The SQS protocol client and the AWS credential
// resolver are mocked, so queue selection is observable without any network.
// The state object is pre-created here: before task 017 lands, env.ts imports
// neither mocked module, so their own initialization never runs.
globalThis.__sqsEnv = globalThis.__sqsEnv ?? { sends: [], configCalls: 0 };
const { app } = await loadApp("aws-node-env", `export { createNodeRuntime } from "./server/runtime/env.ts";`, {
	mocks: {
		"@/lib/aws/sqs": `
			const state = (globalThis.__sqsEnv = globalThis.__sqsEnv ?? { sends: [], configCalls: 0 });
			export async function sqsSendMessage(config, opts) { state.sends.push(opts); return { messageId: "m-1" }; }
			export async function sqsSendMessageBatch() {}
			export async function sqsReceiveMessage() { return { messages: [] }; }
			export async function sqsDeleteMessage() {}
			export async function sqsChangeMessageVisibility() {}
		`,
		"@/lib/aws/config": `
			const state = (globalThis.__sqsEnv = globalThis.__sqsEnv ?? { sends: [], configCalls: 0 });
			export async function getAwsConfig(env) { state.configCalls += 1; return { accessKeyId: "AKI", secretAccessKey: "s", region: "us-east-1" }; }
			export async function requireAwsConfig(env) { return getAwsConfig(env); }
		`,
	},
});

const state = () => globalThis.__sqsEnv;

/** Creates the runtime with the given process env (plus a temp DATA_DIR) and cleans up after the test. */
function buildRuntime(t, vars) {
	state().sends = [];
	state().configCalls = 0;
	const dataDir = mkdtempSync(join(tmpdir(), "mailflare-node-sqs-"));
	const saved = { ...process.env };
	Object.assign(process.env, vars, { DATA_DIR: dataDir });
	const runtime = app.createNodeRuntime();
	t.after(() => {
		for (const queue of [runtime.inboundQueue, runtime.outboundQueue, runtime.agentQueue]) queue.stop?.();
		runtime.database?.db.close();
		for (const key of [...Object.keys(vars), "DATA_DIR"]) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dataDir, { recursive: true, force: true });
	});
	return runtime;
}

const sqsUrls = {
	SQS_INBOUND_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/111122223333/mailflare-inbound",
	SQS_OUTBOUND_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/111122223333/mailflare-outbound",
	AGENT_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/111122223333/mailflare-agent",
};

test("queue URLs select SQS-backed queues that resolve credentials lazily", async (t) => {
	const runtime = buildRuntime(t, sqsUrls);
	assert.equal(state().configCalls, 0, "no credentials are resolved while the env is assembled");
	await runtime.env.INBOUND_QUEUE.send({ n: 1 });
	await runtime.env.OUTBOUND_QUEUE.send({ n: 2 });
	await runtime.env.AGENT_QUEUE.send({ n: 3 });
	assert.deepEqual(state().sends.map((send) => send.queueUrl), [
		sqsUrls.SQS_INBOUND_QUEUE_URL,
		sqsUrls.SQS_OUTBOUND_QUEUE_URL,
		sqsUrls.AGENT_QUEUE_URL,
	]);
	assert.ok(state().configCalls >= 1, "the queues resolve AWS credentials when they are actually used");
});

test("without queue URLs the in-process queues stay in place", async (t) => {
	const runtime = buildRuntime(t, {});
	assert.equal(runtime.inboundQueue.constructor.name, "InProcessQueue");
	await runtime.env.INBOUND_QUEUE.send({ n: 1 });
	assert.deepEqual(state().sends, [], "nothing reaches SQS");
});

test("a mixed configuration keeps the in-process default per queue", async (t) => {
	const runtime = buildRuntime(t, { SQS_INBOUND_QUEUE_URL: sqsUrls.SQS_INBOUND_QUEUE_URL });
	assert.equal(runtime.inboundQueue.constructor.name, "SqsQueue");
	assert.equal(runtime.outboundQueue.constructor.name, "InProcessQueue");
	assert.equal(runtime.agentQueue.constructor.name, "InProcessQueue");
	await runtime.env.INBOUND_QUEUE.send({ n: 1 });
	await runtime.env.OUTBOUND_QUEUE.send({ n: 2 });
	assert.deepEqual(state().sends.map((send) => send.queueUrl), [sqsUrls.SQS_INBOUND_QUEUE_URL]);
});

test("the task-role credential variables reach the built env", (t) => {
	const runtime = buildRuntime(t, { AWS_SESSION_TOKEN: "tok-1", AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds" });
	assert.equal(runtime.env.AWS_SESSION_TOKEN, "tok-1");
	assert.equal(runtime.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, "/v2/creds");
});
