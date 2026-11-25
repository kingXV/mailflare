import { normalizeHostname } from "@/lib/domains/utils";
import { findZoneByHostname } from "@/lib/cloudflare-api";
import { MANUAL_ZONE_ID } from "@/lib/domains/provision";
import type { DomainPreflightResult } from "@/lib/domains/types";
import { hasCloudflareCredentials } from "@/lib/runtime";
import { getAwsConfig } from "@/lib/aws/config";
import { findRoute53ZoneByHostname } from "@/lib/aws/route53";

export async function preflightDomain(
	env: CloudflareEnv,
	hostname: string,
): Promise<DomainPreflightResult> {
	const normalized = normalizeHostname(hostname);
	if (!hasCloudflareCredentials(env)) {
		const awsConfig = await getAwsConfig(env);
		if (awsConfig) {
			const zone = await findRoute53ZoneByHostname(awsConfig, normalized);
			if (zone) return { hostname: normalized, zone: { id: `r53:${zone.id}`, name: zone.name } };
			throw new Error(
				`Zone not found for "${normalized}". The domain must use Route 53 DNS on this AWS account.`,
			);
		}
	}

	const zone = await findZoneByHostname(env, normalized);
	if (!zone) {
		throw new Error(
			`Zone not found for "${normalized}". The domain must use Cloudflare DNS on this account.`,
		);
	}

	return { hostname: normalized, zone };
}

/** A domain this install will not manage on Cloudflare. Same zone id provisionDomainOnCloudflare records. */
export function manualDomainPreflight(hostname: string): DomainPreflightResult {
	const normalized = normalizeHostname(hostname);
	return { hostname: normalized, zone: { id: MANUAL_ZONE_ID, name: normalized } };
}

/**
 * First-run domain check. Skipping DNS must not call any zone API. Without
 * Cloudflare credentials, a Route 53 hosted zone resolves when AWS is
 * configured; otherwise the domain is manually managed and the operator
 * sets records by hand.
 */
export async function preflightSetupDomain(
	env: CloudflareEnv,
	hostname: string,
	options?: { skipDns?: boolean },
): Promise<DomainPreflightResult> {
	if (options?.skipDns) return manualDomainPreflight(hostname);
	if (hasCloudflareCredentials(env)) return preflightDomain(env, hostname);
	const awsConfig = await getAwsConfig(env);
	if (awsConfig) {
		const normalized = normalizeHostname(hostname);
		const zone = await findRoute53ZoneByHostname(awsConfig, normalized);
		if (zone) return { hostname: normalized, zone: { id: `r53:${zone.id}`, name: zone.name } };
	}
	return manualDomainPreflight(hostname);
}
