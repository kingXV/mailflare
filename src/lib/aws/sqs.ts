import { awsJson } from "@/lib/aws/client";
import type { AwsConfig } from "@/lib/aws/aws-types";

/** Message attribute values the app sends and consumes are plain strings. */
export type SqsMessageAttributes = Record<string, string>;

export type SqsSendInput = {
	queueUrl: string;
	/** Serialized with JSON.stringify before sending. */
	body: unknown;
	delaySeconds?: number;
	messageAttributes?: SqsMessageAttributes;
};

export type SqsSendBatchInput = {
	queueUrl: string;
	messages: SqsSendInput[];
};

export type SqsReceivedMessage = {
	receiptHandle: string;
	/** Raw message body string; the consumer parses it. */
	body: string;
	attributes: { approximateReceiveCount?: number };
	messageAttributes: SqsMessageAttributes;
};

export type SqsReceiveInput = {
	queueUrl: string;
	maxNumberOfMessages?: number;
	waitTimeSeconds?: number;
	visibilityTimeout?: number;
};

export type SqsDeleteInput = {
	queueUrl: string;
	receiptHandle: string;
};

export type SqsChangeVisibilityInput = {
	queueUrl: string;
	receiptHandle: string;
	visibilityTimeout: number;
};

/** SQS JSON protocol: x-amz-json-1.0 body with an AmazonSQS.<Action> target. */
async function sqsCall<T>(config: AwsConfig, action: string, payload: Record<string, unknown>): Promise<T> {
	return awsJson<T>({
		config,
		service: "sqs",
		method: "POST",
		json: payload,
		headers: {
			"Content-Type": "application/x-amz-json-1.0",
			"X-Amz-Target": `AmazonSQS.${action}`,
		},
	});
}

function encodeMessageAttributes(attributes: SqsMessageAttributes | undefined): Record<string, { DataType: "String"; StringValue: string }> | undefined {
	if (!attributes) return undefined;
	return Object.fromEntries(Object.entries(attributes).map(([name, value]) => [name, { DataType: "String" as const, StringValue: value }]));
}

function decodeMessageAttributes(attributes: Record<string, { DataType: string; StringValue?: string }> | undefined): SqsMessageAttributes {
	const decoded: SqsMessageAttributes = {};
	for (const [name, attribute] of Object.entries(attributes ?? {})) {
		if (attribute?.StringValue !== undefined) decoded[name] = attribute.StringValue;
	}
	return decoded;
}

export async function sqsSendMessage(config: AwsConfig, input: SqsSendInput): Promise<{ messageId?: string }> {
	const payload: Record<string, unknown> = {
		QueueUrl: input.queueUrl,
		MessageBody: JSON.stringify(input.body),
	};
	if (input.delaySeconds !== undefined) payload.DelaySeconds = input.delaySeconds;
	const messageAttributes = encodeMessageAttributes(input.messageAttributes);
	if (messageAttributes) payload.MessageAttributes = messageAttributes;
	const result = await sqsCall<{ MessageId?: string }>(config, "SendMessage", payload);
	return { messageId: result.MessageId };
}

export async function sqsSendMessageBatch(config: AwsConfig, input: SqsSendBatchInput): Promise<{ successful: string[] }> {
	const entries = input.messages.map((message, index) => {
		const entry: Record<string, unknown> = { Id: `msg-${index}`, MessageBody: JSON.stringify(message.body) };
		if (message.delaySeconds !== undefined) entry.DelaySeconds = message.delaySeconds;
		const messageAttributes = encodeMessageAttributes(message.messageAttributes);
		if (messageAttributes) entry.MessageAttributes = messageAttributes;
		return entry;
	});
	const result = await sqsCall<{ Successful?: Array<{ Id: string }>; Failed?: Array<{ Id: string; Message?: string }> }>(config, "SendMessageBatch", {
		QueueUrl: input.queueUrl,
		Entries: entries,
	});
	if (result.Failed?.length) throw new Error(`SQS SendMessageBatch failed for entries: ${result.Failed.map((failed) => failed.Id).join(", ")}`);
	return { successful: (result.Successful ?? []).map((entry) => entry.Id) };
}

export async function sqsReceiveMessage(config: AwsConfig, input: SqsReceiveInput): Promise<{ messages: SqsReceivedMessage[] }> {
	const payload: Record<string, unknown> = {
		QueueUrl: input.queueUrl,
		MaxNumberOfMessages: input.maxNumberOfMessages ?? 10,
		WaitTimeSeconds: input.waitTimeSeconds ?? 0,
		AttributeNames: ["ApproximateReceiveCount"],
		MessageAttributeNames: ["All"],
	};
	if (input.visibilityTimeout !== undefined) payload.VisibilityTimeout = input.visibilityTimeout;
	const result = await sqsCall<{ Messages?: Array<{ ReceiptHandle: string; Body: string; Attributes?: Record<string, string>; MessageAttributes?: Record<string, { DataType: string; StringValue?: string }> }> }>(config, "ReceiveMessage", payload);
	const messages = (result.Messages ?? []).map((message) => {
		const attributes: { approximateReceiveCount?: number } = {};
		const receiveCount = message.Attributes?.ApproximateReceiveCount;
		if (receiveCount !== undefined) attributes.approximateReceiveCount = Number(receiveCount);
		return {
			receiptHandle: message.ReceiptHandle,
			body: message.Body,
			attributes,
			messageAttributes: decodeMessageAttributes(message.MessageAttributes),
		};
	});
	return { messages };
}

export async function sqsDeleteMessage(config: AwsConfig, input: SqsDeleteInput): Promise<void> {
	await sqsCall(config, "DeleteMessage", { QueueUrl: input.queueUrl, ReceiptHandle: input.receiptHandle });
}

export async function sqsChangeMessageVisibility(config: AwsConfig, input: SqsChangeVisibilityInput): Promise<void> {
	await sqsCall(config, "ChangeMessageVisibility", { QueueUrl: input.queueUrl, ReceiptHandle: input.receiptHandle, VisibilityTimeout: input.visibilityTimeout });
}
