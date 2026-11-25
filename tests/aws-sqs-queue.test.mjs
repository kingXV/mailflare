import assert from "node:assert/strict";
import test from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

// SqsQueue from server/runtime/queue.ts, with the SQS protocol client mocked so
// the long-poll consumer loop is driven deterministically: an empty receive
// script parks the loop until the test delivers the next batch.
const queueUrl = "https://sqs.us-east-1.amazonaws.com/111122223333/mailflare-inbound";
const config = { accessKeyId: "AKI", secretAccessKey: "s", region: "us-east-1" };
const fixture = await loadFixture({
	name: "aws-sqs-queue",
	entryPoint: "server/runtime/queue.ts",
	mocks: {
		"@/lib/aws/sqs": `
			// Read the state object per call (not captured at module-eval time):
			// the tests' reset() installs a fresh object per test, and the mock
			// must always observe the current one (same harness fix as
			// tests/aws-s3-config.test.mjs, dcd3210).
			const state = () => (globalThis.__sqsQueue = globalThis.__sqsQueue ?? { script: [], parked: [], sends: [], deleted: [], visibility: [], receives: [] });
			export async function sqsSendMessage(config, opts) { state().sends.push(opts); return { messageId: "m-1" }; }
			export async function sqsSendMessageBatch(config, opts) { state().sends.push(opts); return { successful: [], failed: [] }; }
			export async function sqsReceiveMessage(config, opts) {
				const current = state();
				current.receives.push(opts);
				const next = current.script.shift();
				if (!next) return new Promise((resolve) => current.parked.push(resolve));
				if (next.error) throw next.error;
				return next.value;
			}
			export async function sqsDeleteMessage(config, opts) { state().deleted.push(opts); }
			export async function sqsChangeMessageVisibility(config, opts) { state().visibility.push(opts); }
		`,
	},
});
const mod = await fixture.import();
test.after(() => fixture.dispose());

const state = () => globalThis.__sqsQueue;
const reset = () => {
	globalThis.__sqsQueue = { script: [], parked: [], sends: [], deleted: [], visibility: [], receives: [] };
};

async function waitFor(predicate, label) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** The consumer loop is at its next receive (all prior work is finished) once it parks. */
const waitUntilParked = () => waitFor(() => state().parked.length > 0, "queue loop parked");

async function deliver(value) {
	const current = state();
	if (current.parked.length > 0) {
		const release = current.parked.shift();
		release(value.error ? Promise.reject(value.error) : value.value);
	} else {
		current.script.push(value);
	}
}

const message = (overrides = {}) => ({
	receiptHandle: "rh-1",
	body: JSON.stringify({ kind: "inbound" }),
	attributes: { approximateReceiveCount: 1 },
	messageAttributes: {},
	...overrides,
});

test("send caps the SQS delay at 900 seconds and carries the rest as a dueAt attribute", async () => {
	reset();
	const queue = mod.openSqsQueue("mailflare-outbound", queueUrl, async () => config);
	await queue.send({ id: "m1" }, { delaySeconds: 3600 });
	await queue.send({ id: "m2" }, { delaySeconds: 30 });
	const [capped, small] = state().sends;
	assert.equal(capped.queueUrl, queueUrl);
	assert.equal(capped.delaySeconds, 900);
	const dueAt = Number(capped.messageAttributes?.dueAt);
	assert.ok(Math.abs(dueAt - (Math.floor(Date.now() / 1000) + 3600)) <= 5, `dueAt was ${dueAt}`);
	assert.equal(small.delaySeconds, 30);
	assert.equal("dueAt" in (small.messageAttributes ?? {}), false, "short delays need no dueAt");
});

test("a not-yet-due message is pushed back with ChangeMessageVisibility and never processed", async () => {
	reset();
	let consumed = 0;
	const queue = mod.openSqsQueue("mailflare-inbound", queueUrl, async () => config);
	queue.setConsumer(async () => { consumed += 1; });
	await waitUntilParked();
	const receive = state().receives.at(-1);
	assert.equal(receive.waitTimeSeconds, 20, "the loop long-polls");
	assert.equal(receive.maxNumberOfMessages, 5, "the loop receives in batches of five");

	await deliver({ value: { messages: [message({ messageAttributes: { dueAt: String(Math.floor(Date.now() / 1000) + 7200) } })] } });
	await waitUntilParked();
	await deliver({ value: { messages: [message({ receiptHandle: "rh-2", messageAttributes: { dueAt: String(Math.floor(Date.now() / 1000) + 90_000) } })] } });
	await waitUntilParked();

	assert.equal(consumed, 0, "the consumer never runs for a future dueAt");
	assert.deepEqual(state().visibility.map((change) => change.receiptHandle), ["rh-1", "rh-2"]);
	assert.equal(state().visibility[0].visibilityTimeout, 7200, "the remaining delay is handed back");
	assert.equal(state().visibility[1].visibilityTimeout, 43200, "a single visibility hop is capped at 12 hours");
	assert.deepEqual(state().deleted, []);
	await queue.stop();
});

test("a due message reaches the consumer with attempts counted, and ack deletes it", async () => {
	reset();
	let seen;
	const queue = mod.openSqsQueue("mailflare-inbound", queueUrl, async () => config);
	queue.setConsumer(async (body, meta) => { seen = { body, meta }; meta.ack(); });
	await waitUntilParked();
	await deliver({ value: { messages: [message({ receiptHandle: "rh-3", attributes: { approximateReceiveCount: 4 } })] } });
	await waitUntilParked();

	assert.deepEqual(seen.body, { kind: "inbound" }, "the raw body is parsed before the consumer runs");
	assert.equal(seen.meta.attempts, 3, "attempts count the deliveries before this one");
	assert.equal(typeof seen.meta.retry, "function");
	assert.deepEqual(state().deleted, [{ queueUrl, receiptHandle: "rh-3" }]);
	assert.deepEqual(state().visibility, [], "an acked message is not re-pushed");
	await queue.stop();
});

test("meta.retry maps onto ChangeMessageVisibility and skips the delete", async () => {
	reset();
	const queue = mod.openSqsQueue("mailflare-inbound", queueUrl, async () => config);
	queue.setConsumer(async (body, meta) => { meta.retry({ delaySeconds: 300 }); });
	await waitUntilParked();
	await deliver({ value: { messages: [message({ receiptHandle: "rh-4" })] } });
	await waitUntilParked();

	assert.deepEqual(state().visibility, [{ queueUrl, receiptHandle: "rh-4", visibilityTimeout: 300 }]);
	assert.deepEqual(state().deleted, []);
	await queue.stop();
});

test("a thrown error without retry defaults to a ten-second visibility timeout", async () => {
	reset();
	const queue = mod.openSqsQueue("mailflare-inbound", queueUrl, async () => config);
	queue.setConsumer(async () => { throw new Error("consumer exploded"); });
	await waitUntilParked();
	await deliver({ value: { messages: [message({ receiptHandle: "rh-5" })] } });
	await waitUntilParked();

	assert.deepEqual(state().visibility, [{ queueUrl, receiptHandle: "rh-5", visibilityTimeout: 10 }]);
	assert.deepEqual(state().deleted, []);
	await queue.stop();
});

test("stop waits for an in-flight consumer before returning", async () => {
	reset();
	let releaseConsumer;
	const queue = mod.openSqsQueue("mailflare-inbound", queueUrl, async () => config);
	queue.setConsumer(() => new Promise((resolve) => { releaseConsumer = resolve; }));
	await waitUntilParked();
	await deliver({ value: { messages: [message()] } });
	await waitFor(() => releaseConsumer != null, "consumer in flight");

	const stopping = queue.stop();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(state().receives.length, 1, "no further receives happen while draining");
	releaseConsumer();
	await stopping;
	assert.ok(true, "stop() resolved after the in-flight consumer finished");
});

test("a receive error retries without crashing the loop", async () => {
	reset();
	let consumed = 0;
	const queue = mod.openSqsQueue("mailflare-inbound", queueUrl, async () => config);
	queue.setConsumer(async () => { consumed += 1; });
	await waitUntilParked();
	await deliver({ error: new Error("SQS receive failed") });
	await waitUntilParked();
	await deliver({ value: { messages: [message({ receiptHandle: "rh-6" })] } });
	await waitUntilParked();

	assert.equal(consumed, 1, "the loop survived the receive error and processed the next delivery");
	await queue.stop();
});
