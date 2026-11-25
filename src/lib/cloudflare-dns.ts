import { requireAwsConfig } from "@/lib/aws/config";
import { createRoute53Record, deleteRoute53Record, listRoute53Records, updateRoute53Record } from "@/lib/aws/route53";
import { cfRequest } from "@/lib/cloudflare-api";
import type { CfDnsRecord } from "@/lib/cloudflare-api.types";
import type { CloudflareDnsRecordCreate } from "@/lib/cloudflare-dns.types";

/** Route 53 zones are stored app-side with an `r53:` prefix on the zone id. */
const isRoute53Zone = (zoneId: string) => zoneId.startsWith("r53:");

export async function listMxRecords(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
): Promise<CfDnsRecord[]> {
	if (isRoute53Zone(zoneId)) {
		return listRoute53Records(await requireAwsConfig(env), zoneId, { type: "MX", name: hostname });
	}
	return cfRequest<CfDnsRecord[]>(
		env,
		`/zones/${zoneId}/dns_records?type=MX&name=${encodeURIComponent(hostname)}&per_page=5000`,
	);
}

export async function listDnsRecords(
	env: CloudflareEnv,
	zoneId: string,
	params: { type: string; name: string },
): Promise<CfDnsRecord[]> {
	if (isRoute53Zone(zoneId)) {
		return listRoute53Records(await requireAwsConfig(env), zoneId, params);
	}
	return cfRequest<CfDnsRecord[]>(
		env,
		`/zones/${zoneId}/dns_records?type=${encodeURIComponent(params.type)}&name=${encodeURIComponent(params.name)}&per_page=5000`,
	);
}

export async function deleteDnsRecord(
	env: CloudflareEnv,
	zoneId: string,
	recordId: string,
): Promise<void> {
	if (isRoute53Zone(zoneId)) {
		await deleteRoute53Record(await requireAwsConfig(env), zoneId, recordId);
		return;
	}
	await cfRequest<unknown>(env, `/zones/${zoneId}/dns_records/${recordId}`, {
		method: "DELETE",
	});
}

export async function createDnsRecord(
	env: CloudflareEnv,
	zoneId: string,
	record: CloudflareDnsRecordCreate,
): Promise<CfDnsRecord> {
	if (isRoute53Zone(zoneId)) {
		return createRoute53Record(await requireAwsConfig(env), zoneId, {
			type: record.type,
			name: record.name,
			content: record.content,
			ttl: record.ttl,
			...(record.type === "MX" ? { priority: record.priority } : {}),
		});
	}
	return cfRequest<CfDnsRecord>(env, `/zones/${zoneId}/dns_records`, {
		method: "POST",
		body: JSON.stringify(record),
	});
}

/** Changes the content (and optionally the TTL) of a record in place; nothing else about it can be sent. */
export async function updateDnsRecord(
	env: CloudflareEnv,
	zoneId: string,
	recordId: string,
	changes: { content: string; ttl?: number },
): Promise<CfDnsRecord> {
	if (isRoute53Zone(zoneId)) {
		return updateRoute53Record(await requireAwsConfig(env), zoneId, recordId, changes);
	}
	const body: { content: string; ttl?: number } = { content: changes.content };
	if (changes.ttl !== undefined) body.ttl = changes.ttl;
	return cfRequest<CfDnsRecord>(env, `/zones/${zoneId}/dns_records/${recordId}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
}
