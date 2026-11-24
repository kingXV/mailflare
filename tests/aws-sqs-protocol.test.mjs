import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src/lib/aws/sqs.ts");
// Task 002 creates this module. Until it exists, fail on the module import
// itself (the expected red state) rather than on a bundling error.
if (!existsSync(source)) await import(pathToFileURL(source).href);

const outDir = mkdtempSync(join(tmpdir(), "mailflare-sqs-"));
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

const sqs = await bundle("src/lib/aws/sqs.ts", "sqs.mjs");

const config = { accessKeyId: "AKIAEXAMPLE000000000", secretAccessKey: "x".repeat(40), region: "us-east-1" };
const queueUrl = "https://sqs.us-east-1.amazonaws.com/111122223333/mailflare-inbound";

function mockSqs(handler) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
		const body = typeof init.body === "string" ? init.body : "";
		const call = { url, method: init.method ?? "GET", body, headers: init.headers ?? {} };
		let json = null;
		try { json = JSON.parse(body); } catch { /* not JSON */ }
		call.json = json;
		calls.push(call);
		const result = handler(call);
		return new Response(result.body, { status: result.status ?? 200 });
	};
	return { calls, restore: () => { globalThis.fetch = original; } };
}

const header = (call, name) => Object.entries(call.headers).find(([key]) => key.toLowerCase() === name)?.[1];

test("sqsSendMessage posts the JSON protocol with the AmazonSQS target and signs for the sqs service", async () => {
	const mock = mockSqs(() => ({ body: JSON.stringify({ MessageId: "m-1" }) }));
	try {
		await sqs.sqsSendMessage(config, { queueUrl, body: { kind: "inbound", id: 42 } });
		const call = mock.calls[0];
		assert.equal(call.url.host, "sqs.us-east-1.amazonaws.com");
		assert.equal(call.method, "POST");
		assert.equal(header(call, "content-type"), "application/x-amz-json-1.0");
		assert.equal(header(call, "x-amz-target"), "AmazonSQS.SendMessage");
		assert.match(header(call, "authorization"), /Credential=AKIAEXAMPLE000000000\/\d{8}\/us-east-1\/sqs\/aws4_request/);
		assert.equal(call.json.QueueUrl, queueUrl);
		assert.equal(call.json.MessageBody, JSON.stringify({ kind: "inbound", id: 42 }), "the body is serialized with JSON.stringify");
		assert.equal("DelaySeconds" in call.json, false);
	} finally { mock.restore(); }
});

test("sqsSendMessage passes DelaySeconds and string message attributes", async () => {
	const mock = mockSqs(() => ({ body: JSON.stringify({ MessageId: "m-2" }) }));
	try {
		await sqs.sqsSendMessage(config, { queueUrl, body: { n: 1 }, delaySeconds: 30, messageAttributes: { dueAt: "1700000000" } });
		const json = mock.calls[0].json;
		assert.equal(json.DelaySeconds, 30);
		assert.deepEqual(json.MessageAttributes, { dueAt: { DataType: "String", StringValue: "1700000000" } });
	} finally { mock.restore(); }
});

test("sqsSendMessageBatch posts one entry per message with unique generated ids", async () => {
	const mock = mockSqs(({ json }) => ({ body: JSON.stringify({ Successful: (json?.Entries ?? []).map((entry) => ({ Id: entry.Id })) }) }));
	try {
		await sqs.sqsSendMessageBatch(config, { queueUrl, messages: [{ body: { n: 1 } }, { body: { n: 2 }, delaySeconds: 5 }] });
		const call = mock.calls[0];
		assert.equal(header(call, "x-amz-target"), "AmazonSQS.SendMessageBatch");
		assert.equal(call.json.QueueUrl, queueUrl);
		assert.equal(call.json.Entries.length, 2);
		assert.equal(new Set(call.json.Entries.map((entry) => entry.Id)).size, 2, "entry ids are unique");
		assert.equal(call.json.Entries[0].MessageBody, JSON.stringify({ n: 1 }));
		assert.equal(call.json.Entries[1].DelaySeconds, 5);
		assert.equal("DelaySeconds" in call.json.Entries[0], false);
	} finally { mock.restore(); }
});

test("sqsSendMessageBatch throws naming the failed entry ids when some sends fail", async () => {
	let failedId = "";
	const mock = mockSqs(({ json }) => {
		failedId = json.Entries[1].Id;
		return { body: JSON.stringify({ Failed: [{ Id: failedId, Message: "InternalError" }] }) };
	});
	try {
		await assert.rejects(
			() => sqs.sqsSendMessageBatch(config, { queueUrl, messages: [{ body: { n: 1 } }, { body: { n: 2 } }] }),
			(error) => error instanceof Error && error.message.includes(failedId),
		);
	} finally { mock.restore(); }
});

test("sqsReceiveMessage long-polls and parses receipt handle, receive count and message attributes", async () => {
	const mock = mockSqs(() => ({ body: JSON.stringify({ Messages: [{
		MessageId: "m-3",
		ReceiptHandle: "rh-1",
		Body: JSON.stringify({ kind: "inbound" }),
		Attributes: { ApproximateReceiveCount: "3" },
		MessageAttributes: { dueAt: { DataType: "String", StringValue: "1700000000" } },
	}] }) }));
	try {
		const result = await sqs.sqsReceiveMessage(config, { queueUrl, maxNumberOfMessages: 5, waitTimeSeconds: 20, visibilityTimeout: 300 });
		const call = mock.calls[0];
		assert.equal(header(call, "x-amz-target"), "AmazonSQS.ReceiveMessage");
		assert.equal(call.json.QueueUrl, queueUrl);
		assert.equal(call.json.MaxNumberOfMessages, 5);
		assert.equal(call.json.WaitTimeSeconds, 20);
		assert.equal(call.json.VisibilityTimeout, 300);
		assert.deepEqual(call.json.AttributeNames, ["ApproximateReceiveCount"]);
		assert.ok(call.json.MessageAttributeNames.includes("All"));
		assert.equal(result.messages.length, 1);
		assert.equal(result.messages[0].receiptHandle, "rh-1");
		assert.equal(result.messages[0].body, JSON.stringify({ kind: "inbound" }), "the raw message body is returned for the consumer to parse");
		assert.deepEqual(result.messages[0].attributes, { approximateReceiveCount: 3 });
		assert.deepEqual(result.messages[0].messageAttributes, { dueAt: "1700000000" });
	} finally { mock.restore(); }
});

test("sqsReceiveMessage returns an empty list when the queue answers no messages", async () => {
	const mock = mockSqs(() => ({ body: "{}" }));
	try {
		const result = await sqs.sqsReceiveMessage(config, { queueUrl, maxNumberOfMessages: 10, waitTimeSeconds: 0 });
		assert.deepEqual(result.messages, []);
	} finally { mock.restore(); }
});

test("sqsDeleteMessage removes messages by receipt handle", async () => {
	const mock = mockSqs(() => ({ body: "{}" }));
	try {
		await sqs.sqsDeleteMessage(config, { queueUrl, receiptHandle: "rh-9" });
		const call = mock.calls[0];
		assert.equal(header(call, "x-amz-target"), "AmazonSQS.DeleteMessage");
		assert.deepEqual(call.json, { QueueUrl: queueUrl, ReceiptHandle: "rh-9" });
	} finally { mock.restore(); }
});

test("sqsChangeMessageVisibility posts the receipt handle and timeout", async () => {
	const mock = mockSqs(() => ({ body: "{}" }));
	try {
		await sqs.sqsChangeMessageVisibility(config, { queueUrl, receiptHandle: "rh-9", visibilityTimeout: 300 });
		const call = mock.calls[0];
		assert.equal(header(call, "x-amz-target"), "AmazonSQS.ChangeMessageVisibility");
		assert.deepEqual(call.json, { QueueUrl: queueUrl, ReceiptHandle: "rh-9", VisibilityTimeout: 300 });
	} finally { mock.restore(); }
});
