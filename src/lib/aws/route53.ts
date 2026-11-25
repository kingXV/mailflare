/** Route 53 DNS records: REST-XML on the global endpoint, mapping every DNS operation onto ChangeResourceRecordSets. */

import { awsRequest, AwsError } from "@/lib/aws/client";
import { xmlBlocks, xmlTag, xmlTags } from "@/lib/aws/xml";
import type { AwsConfig } from "@/lib/aws/aws-types";
import type { CfDnsRecord } from "@/lib/cloudflare-api.types";

const HOST = "route53.amazonaws.com";
/** Route 53 is a global service: one endpoint, always signed against us-east-1. */
const REGION = "us-east-1";
const API = "/2013-04-01";
const API_XMLNS = "https://route53.amazonaws.com/doc/2013-04-01/";

const escapeXml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fqdn = (name: string) => (name.endsWith(".") ? name : `${name}.`);
const bare = (name: string) => name.replace(/\.$/, "");

/** Zone ids are stored app-side with an `r53:` prefix; the wire path wants the bare id. */
const zonePathId = (zoneId: string) => zoneId.replace(/^r53:/, "").replace(/^\/hostedzone\//, "");

/** Synthetic record id: a pure hash of the raw value, so the same value always maps to the same id. */
async function recordIdFor(type: string, name: string, rawValue: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(rawValue));
	let binary = "";
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
	return `r53:${type}:${name}:${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

async function request(
	config: AwsConfig,
	options: { path: string; query?: Record<string, string>; method?: string; body?: string },
): Promise<string> {
	const response = await awsRequest({
		config,
		service: "route53",
		host: HOST,
		region: REGION,
		method: options.method,
		path: options.path,
		query: options.query,
		body: options.body,
		headers: options.body === undefined ? undefined : { "Content-Type": "application/xml" },
	});
	return response.text();
}

type RecordSet = { name: string; type: string; ttl: number; values: string[] };

/** Fetches the rrsets at a name and type, filtered to the exact set. Alias (ELB/CloudFront) records are never touched. */
async function fetchRecordSet(config: AwsConfig, zoneId: string, name: string, type: string): Promise<RecordSet[]> {
	const xml = await request(config, {
		path: `${API}/hostedzone/${zonePathId(zoneId)}/rrset`,
		query: { name: fqdn(name), type, maxitems: "100" },
	});
	const wanted = bare(name).toLowerCase();
	return xmlBlocks(xml, "ResourceRecordSet")
		.filter((block) => !block.includes("<AliasTarget>"))
		.map((block) => ({
			name: bare(xmlTag(block, "Name") ?? ""),
			type: xmlTag(block, "Type") ?? "",
			ttl: Number(xmlTag(block, "TTL")) || 300,
			values: xmlTags(block, "Value"),
		}))
		.filter((set) => set.name.toLowerCase() === wanted && set.type === type);
}

type RecordChange = { action: "UPSERT" | "DELETE"; name: string; type: string; ttl: number; values: string[] };

async function changeRecords(config: AwsConfig, zoneId: string, changes: RecordChange[]): Promise<void> {
	const body = `<ChangeResourceRecordSetsRequest xmlns="${API_XMLNS}"><ChangeBatch><Changes>${changes.map((change) =>
		`<Change><Action>${change.action}</Action><ResourceRecordSet><Name>${escapeXml(change.name)}</Name><Type>${escapeXml(change.type)}</Type><TTL>${change.ttl}</TTL><ResourceRecords>${change.values.map((value) => `<ResourceRecord><Value>${escapeXml(value)}</Value></ResourceRecord>`).join("")}</ResourceRecords></ResourceRecordSet></Change>`
	).join("")}</Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
	await request(config, { method: "POST", path: `${API}/hostedzone/${zonePathId(zoneId)}/rrset`, body });
}

/** The raw Route 53 value for a record's content: MX joins priority and host, TXT is quoted and chunked at 255 characters. */
function encodeValue(type: string, content: string, priority?: number): string {
	if (type === "MX") return `${priority ?? 10} ${content}`;
	if (type === "TXT") return content.match(/[\s\S]{1,255}/g)?.map((chunk) => `"${chunk}"`).join(" ") ?? '""';
	return content;
}

export async function findRoute53ZoneByHostname(config: AwsConfig, hostname: string): Promise<{ id: string; name: string } | null> {
	const host = bare(hostname.toLowerCase());
	const labels = host.split(".");
	// Walk from the most specific name up; the bare TLD is never a zone we manage.
	for (let skip = 0; skip < labels.length - 1; skip++) {
		const dnsname = labels.slice(skip).join(".");
		const xml = await request(config, { path: `${API}/hostedzonesbyname`, query: { dnsname, maxitems: "1" } });
		const zone = xmlBlocks(xml, "HostedZone")[0];
		if (!zone) continue;
		if (xmlTag(xmlTag(zone, "Config") ?? "", "PrivateZone") === "true") continue;
		const name = bare(xmlTag(zone, "Name") ?? "").toLowerCase();
		const id = (xmlTag(zone, "Id") ?? "").replace(/^\/hostedzone\//, "");
		if (!name || !id) continue;
		// listHostedZonesByName answers with the next zone alphabetically, so re-check the suffix.
		if (host === name || host.endsWith(`.${name}`)) return { id, name };
	}
	return null;
}

export async function listRoute53Records(config: AwsConfig, zoneId: string, query: { type: string; name: string }): Promise<CfDnsRecord[]> {
	const sets = await fetchRecordSet(config, zoneId, query.name, query.type);
	const records: CfDnsRecord[] = [];
	for (const set of sets) {
		for (const rawValue of set.values) {
			const record: CfDnsRecord = { id: await recordIdFor(set.type, set.name, rawValue), type: set.type, name: set.name, ttl: set.ttl };
			if (set.type === "MX") {
				const mx = /^(\d+)\s+(.+)$/.exec(rawValue);
				if (mx) {
					record.priority = Number(mx[1]);
					record.content = mx[2];
				} else record.content = rawValue;
			} else if (set.type === "TXT") {
				// TXT values arrive as one or more quoted 255-character chunks; join them back into the content.
				const chunks = [...rawValue.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
				record.content = chunks.length ? chunks.join("") : rawValue;
			} else record.content = rawValue;
			records.push(record);
		}
	}
	return records;
}

export async function createRoute53Record(
	config: AwsConfig,
	zoneId: string,
	record: { type: string; name: string; content: string; ttl?: number; priority?: number },
): Promise<CfDnsRecord> {
	const existing = (await fetchRecordSet(config, zoneId, record.name, record.type))[0];
	const rawValue = encodeValue(record.type, record.content, record.priority);
	// Idempotent append: a value already in the set is not written twice.
	const values = existing?.values.includes(rawValue) ? existing.values : [...(existing?.values ?? []), rawValue];
	const ttl = record.ttl ?? existing?.ttl ?? 300;
	await changeRecords(config, zoneId, [{ action: "UPSERT", name: fqdn(record.name), type: record.type, ttl, values }]);
	return {
		id: await recordIdFor(record.type, bare(record.name), rawValue),
		type: record.type,
		name: bare(record.name),
		content: record.content,
		...(record.type === "MX" ? { priority: record.priority ?? 10 } : {}),
		ttl,
	};
}

export async function deleteRoute53Record(config: AwsConfig, zoneId: string, recordId: string): Promise<void> {
	const [, type, name] = recordId.split(":");
	if (!type || !name) return;
	const set = (await fetchRecordSet(config, zoneId, name, type))[0];
	if (!set) return;
	for (let i = 0; i < set.values.length; i++) {
		if (await recordIdFor(type, name, set.values[i]) !== recordId) continue;
		const values = set.values.filter((_, index) => index !== i);
		await changeRecords(config, zoneId, values.length
			? [{ action: "UPSERT", name: fqdn(name), type, ttl: set.ttl, values }]
			: [{ action: "DELETE", name: fqdn(name), type, ttl: set.ttl, values: set.values }]);
		return;
	}
	// The value is already gone; deleting is idempotent.
}

export async function updateRoute53Record(
	config: AwsConfig,
	zoneId: string,
	recordId: string,
	update: { content: string; ttl?: number },
): Promise<CfDnsRecord> {
	const [, type, name] = recordId.split(":");
	if (!type || !name) throw new AwsError(`Invalid Route 53 record id: ${recordId}`, 400, "InvalidRecordId");
	const set = (await fetchRecordSet(config, zoneId, name, type))[0];
	if (!set) throw new AwsError(`No ${type} record set for ${name}`, 404, "NotFound");
	for (let i = 0; i < set.values.length; i++) {
		if (await recordIdFor(type, name, set.values[i]) !== recordId) continue;
		// MX keeps its priority; only the exchange host changes.
		const priority = type === "MX" ? Number(/^(\d+)\s/.exec(set.values[i])?.[1] ?? 10) : undefined;
		const rawValue = encodeValue(type, update.content, priority);
		const values = [...set.values];
		values[i] = rawValue;
		const ttl = update.ttl ?? set.ttl;
		await changeRecords(config, zoneId, [{ action: "UPSERT", name: fqdn(name), type, ttl, values }]);
		return {
			id: await recordIdFor(type, bare(name), rawValue),
			type,
			name: bare(name),
			content: update.content,
			...(priority === undefined ? {} : { priority }),
			ttl,
		};
	}
	throw new AwsError(`Record ${recordId} is no longer in the ${type} set for ${name}`, 404, "NotFound");
}
