/**
 * The Queue producer API with an in-process consumer. Delivery order and the
 * retry policy match wrangler.jsonc (three retries, ten seconds apart on
 * failure). Jobs live in memory and are not re-queued after a restart: inbound
 * mail is already on disk before it is enqueued, but a message whose job is
 * lost stays unprocessed in the blob store, and the raw-mail sweeper removes
 * unreferenced inbound files after 24 hours.
 */
import {
	sqsChangeMessageVisibility,
	sqsDeleteMessage,
	sqsReceiveMessage,
	sqsSendMessage,
	sqsSendMessageBatch,
	type SqsReceivedMessage,
} from "@/lib/aws/sqs";
import type { AwsConfig } from "@/lib/aws/aws-types";

export type QueueConsumer = (body: unknown) => Promise<void>;

type Pending = { body: unknown; attempts: number };

export class InProcessQueue {
	private consumer: QueueConsumer | null = null;
	private readonly maxRetries: number;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();

	constructor(readonly name: string, options?: { maxRetries?: number }) {
		this.maxRetries = options?.maxRetries ?? 3;
	}

	setConsumer(consumer: QueueConsumer) {
		this.consumer = consumer;
	}

	async send(body: unknown, options?: { delaySeconds?: number }) {
		this.schedule({ body, attempts: 0 }, (options?.delaySeconds ?? 0) * 1000);
	}

	async sendBatch(messages: Iterable<{ body: unknown; delaySeconds?: number }>) {
		for (const message of messages) await this.send(message.body, { delaySeconds: message.delaySeconds });
	}

	async metrics() {
		return { backlogCount: this.timers.size };
	}

	private schedule(pending: Pending, delayMs: number) {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			void this.deliver(pending);
		}, delayMs);
		this.timers.add(timer);
	}

	private async deliver(pending: Pending) {
		if (!this.consumer) {
			this.schedule(pending, 1000);
			return;
		}
		try {
			await this.consumer(pending.body);
		} catch (error) {
			console.error(`Queue ${this.name}: job failed`, error);
			if (pending.attempts < this.maxRetries) this.schedule({ body: pending.body, attempts: pending.attempts + 1 }, 10_000);
			else console.error(`Queue ${this.name}: giving up after ${this.maxRetries} retries`, pending.body);
		}
	}

	stop() {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}
}

export function openQueue<T>(name: string): Queue<T> & InProcessQueue {
	return new InProcessQueue(name) as unknown as Queue<T> & InProcessQueue;
}

/** Message settlement metadata mirroring a Cloudflare Queue Message. */
export type SqsMessageMeta = {
	attempts: number;
	retry: (options?: { delaySeconds?: number }) => void;
	ack: () => void;
};

export type SqsConsumer = (body: unknown, meta: SqsMessageMeta) => Promise<void>;

/** SQS caps SendMessage delays at fifteen minutes. */
const MAX_SEND_DELAY_SECONDS = 900;
/** ChangeMessageVisibility caps a single hop at twelve hours. */
const MAX_VISIBILITY_SECONDS = 43_200;
const RECEIVE_WAIT_SECONDS = 20;
const RECEIVE_BACKOFF_MS = 1_000;
const RECEIVE_BACKOFF_MAX_MS = 30_000;

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * SQS-backed queue for the Node runtime: jobs survive restarts, and delays
 * longer than SQS's fifteen-minute send cap ride a dueAt epoch-seconds
 * attribute, parked with visibility changes until they fall due. Retry caps
 * are left to the queue's redrive policy; a crash mid-processing leaves the
 * message invisible until its visibility timeout re-delivers it.
 */
export class SqsQueue {
	private consumer: SqsConsumer | null = null;
	private controller: AbortController | null = null;
	private drain: Promise<void> = Promise.resolve();
	private readonly maxRetries: number;
	private readonly batchSize: number;

	constructor(
		readonly name: string,
		private readonly queueUrl: string,
		private readonly resolveConfig: () => Promise<AwsConfig>,
		options?: { maxRetries?: number; batchSize?: number },
	) {
		this.maxRetries = options?.maxRetries ?? 3;
		this.batchSize = options?.batchSize ?? 5;
	}

	setConsumer(consumer: SqsConsumer) {
		this.consumer = consumer;
		if (this.controller && !this.controller.signal.aborted) return;
		this.controller = new AbortController();
		this.drain = this.consume(this.controller.signal);
	}

	async send(body: unknown, options?: { delaySeconds?: number }) {
		await sqsSendMessage(await this.resolveConfig(), this.sendInput(body, options?.delaySeconds));
	}

	async sendBatch(messages: Iterable<{ body: unknown; delaySeconds?: number }>) {
		const config = await this.resolveConfig();
		const entries = [...messages].map((message) => this.sendInput(message.body, message.delaySeconds));
		for (let index = 0; index < entries.length; index += 10) {
			await sqsSendMessageBatch(config, { queueUrl: this.queueUrl, messages: entries.slice(index, index + 10) });
		}
	}

	async metrics() {
		// The SQS client does not expose GetQueueAttributes; backlog depth is a
		// CloudWatch metric on the queue itself.
		return { backlogCount: 0, backlogBytes: 0 };
	}

	async stop() {
		this.controller?.abort();
		await this.drain;
	}

	private sendInput(body: unknown, delaySeconds?: number) {
		const seconds = Math.max(0, delaySeconds ?? 0);
		return {
			queueUrl: this.queueUrl,
			body,
			delaySeconds: Math.min(seconds, MAX_SEND_DELAY_SECONDS),
			messageAttributes: seconds > MAX_SEND_DELAY_SECONDS ? { dueAt: String(Math.floor(Date.now() / 1000) + seconds) } : undefined,
		};
	}

	private async consume(signal: AbortSignal) {
		const aborted = new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }));
		while (!signal.aborted) {
			const messages = await this.nextBatch(signal, aborted);
			if (messages === null) return;
			for (const message of messages) {
				if (signal.aborted) return;
				await this.handle(message);
			}
		}
	}

	private async nextBatch(signal: AbortSignal, aborted: Promise<null>): Promise<SqsReceivedMessage[] | null> {
		let backoffMs = RECEIVE_BACKOFF_MS;
		while (!signal.aborted) {
			try {
				const receive = sqsReceiveMessage(await this.resolveConfig(), {
					queueUrl: this.queueUrl,
					maxNumberOfMessages: this.batchSize,
					waitTimeSeconds: RECEIVE_WAIT_SECONDS,
				});
				receive.catch(() => {}); // a rejection landing after stop() must not go unhandled
				const batch = await Promise.race([receive, aborted]);
				return batch === null ? null : batch.messages;
			} catch (error) {
				console.error(`Queue ${this.name}: receive failed`, error);
				await Promise.race([sleep(backoffMs), aborted]);
				backoffMs = Math.min(backoffMs * 2, RECEIVE_BACKOFF_MAX_MS);
			}
		}
		return null;
	}

	private async handle(message: SqsReceivedMessage) {
		const dueAt = message.messageAttributes.dueAt;
		if (dueAt !== undefined) {
			const remaining = Math.ceil((Number(dueAt) * 1000 - Date.now()) / 1000);
			if (remaining > 0) {
				try {
					await this.park(message, Math.min(remaining, MAX_VISIBILITY_SECONDS));
				} catch (error) {
					console.error(`Queue ${this.name}: failed to park a not-yet-due message`, error);
				}
				return;
			}
		}
		let body: unknown;
		try {
			body = JSON.parse(message.body);
		} catch {
			body = message.body;
		}
		// Held in an object so the retry/ack closures' writes stay visible to
		// the settlement below (TS narrowing cannot track closure writes).
		const settlement = { acked: false, retried: false, retrySeconds: 0 };
		const attempts = Number(message.attributes.approximateReceiveCount ?? 1) - 1;
		try {
			await this.consumer?.(body, {
				attempts,
				retry: (options) => { settlement.retried = true; settlement.retrySeconds = options?.delaySeconds ?? 10; },
				ack: () => { settlement.acked = true; },
			});
		} catch (error) {
			console.error(`Queue ${this.name}: job failed`, error);
			if (attempts >= this.maxRetries) console.error(`Queue ${this.name}: retry budget of ${this.maxRetries} spent; SQS redrive will dead-letter the message`);
		}
		try {
			if (settlement.acked) await sqsDeleteMessage(await this.resolveConfig(), { queueUrl: this.queueUrl, receiptHandle: message.receiptHandle });
			else await this.park(message, settlement.retried ? settlement.retrySeconds : 10);
		} catch (error) {
			console.error(`Queue ${this.name}: failed to settle message`, error);
		}
	}

	/** Makes the message invisible for the given window, handing it back to SQS. */
	private async park(message: SqsReceivedMessage, visibilityTimeout: number) {
		await sqsChangeMessageVisibility(await this.resolveConfig(), {
			queueUrl: this.queueUrl,
			receiptHandle: message.receiptHandle,
			visibilityTimeout,
		});
	}
}

export function openSqsQueue<T>(name: string, queueUrl: string, resolveConfig: () => Promise<AwsConfig>, options?: { maxRetries?: number; batchSize?: number }): Queue<T> & SqsQueue {
	return new SqsQueue(name, queueUrl, resolveConfig, options) as unknown as Queue<T> & SqsQueue;
}
