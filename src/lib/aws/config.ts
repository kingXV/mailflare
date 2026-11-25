import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import type { AwsConfig, AwsConfigStatus } from "@/lib/aws/aws-types";

/** Regions where SES can receive mail (SES inbound is not offered everywhere). */
export const SES_RECEIVING_REGIONS = [
	"us-east-1", "us-east-2", "us-west-2", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
	"ca-central-1", "eu-central-1", "eu-west-1", "eu-west-2", "sa-east-1", "us-gov-west-1",
];

const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

export function isValidRegion(region: string): boolean {
	return REGION_PATTERN.test(region);
}

type StoredAws = { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; region?: string; accountId?: string };

async function readStored(env: CloudflareEnv): Promise<StoredAws | null> {
	const [row] = await getDb(env).select({ awsConfig: appSettings.awsConfig }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
	if (!row?.awsConfig) return null;
	try { return JSON.parse(row.awsConfig) as StoredAws; } catch { return null; }
}

/** Where resolved AWS credentials came from; "iam-role" is the ECS task role via container metadata. */
export type AwsConfigStatusSource = "settings" | "environment" | "iam-role";
/** AwsConfigStatus with `source` widened for the ECS task-role case; callers treat it structurally. */
export type AwsConfigStatusWithSource = Omit<AwsConfigStatus, "source"> & { source: AwsConfigStatusSource | null };

type EcsCredentials = { config: AwsConfig; expiresAt: number };
/** Cached ECS task-role credentials, keyed by AWS_CONTAINER_CREDENTIALS_RELATIVE_URI. */
const ecsCredentialsCache = new Map<string, EcsCredentials>();
/** Refresh cached ECS credentials this long before they expire. */
const ECS_CREDENTIALS_REFRESH_MS = 5 * 60 * 1000;
const ECS_METADATA_BASE_URL = "http://169.254.170.2";

/**
 * Rotating task-role credentials from the ECS container metadata endpoint, cached per relative URI and
 * re-fetched while less than five minutes remain. Never throws: any failure (including credentials that
 * arrive already expired) resolves to null so the credential chain falls through to "not configured".
 */
async function readEcsCredentials(env: CloudflareEnv): Promise<AwsConfig | null> {
	const vars = env as unknown as Record<string, string | undefined>;
	const relativeUri = vars.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
	if (!relativeUri) return null;
	const region = (vars.AWS_REGION ?? vars.AWS_DEFAULT_REGION)?.trim();
	if (!region) return null;
	const cached = ecsCredentialsCache.get(relativeUri);
	if (cached && cached.expiresAt - Date.now() > ECS_CREDENTIALS_REFRESH_MS) return cached.config;
	try {
		const response = await fetch(`${ECS_METADATA_BASE_URL}${relativeUri}`);
		if (!response.ok) return null;
		const data = await response.json() as { AccessKeyId?: unknown; SecretAccessKey?: unknown; Token?: unknown; Expiration?: unknown };
		const accessKeyId = typeof data.AccessKeyId === "string" ? data.AccessKeyId : null;
		const secretAccessKey = typeof data.SecretAccessKey === "string" ? data.SecretAccessKey : null;
		const sessionToken = typeof data.Token === "string" ? data.Token : null;
		const expiresAt = typeof data.Expiration === "string" ? Date.parse(data.Expiration) : Number.NaN;
		if (!accessKeyId || !secretAccessKey || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
		const config: AwsConfig = sessionToken
			? { accessKeyId, secretAccessKey, sessionToken, region }
			: { accessKeyId, secretAccessKey, region };
		ecsCredentialsCache.set(relativeUri, { config, expiresAt });
		return config;
	} catch {
		return null;
	}
}

type ResolvedAwsCredentials = { config: AwsConfig; source: AwsConfigStatusSource };

async function resolveAwsCredentialsWithSource(env: CloudflareEnv): Promise<ResolvedAwsCredentials | null> {
	const stored = await readStored(env);
	if (stored?.accessKeyId && stored.secretAccessKey && stored.region) {
		const config: AwsConfig = stored.sessionToken
			? { accessKeyId: stored.accessKeyId, secretAccessKey: stored.secretAccessKey, sessionToken: stored.sessionToken, region: stored.region }
			: { accessKeyId: stored.accessKeyId, secretAccessKey: stored.secretAccessKey, region: stored.region };
		return { config, source: "settings" };
	}
	const vars = env as unknown as Record<string, string | undefined>;
	const accessKeyId = vars.AWS_ACCESS_KEY_ID?.trim();
	const secretAccessKey = vars.AWS_SECRET_ACCESS_KEY?.trim();
	const sessionToken = vars.AWS_SESSION_TOKEN?.trim();
	const region = (vars.AWS_REGION ?? vars.AWS_DEFAULT_REGION)?.trim();
	if (accessKeyId && secretAccessKey && region) {
		const config: AwsConfig = sessionToken
			? { accessKeyId, secretAccessKey, sessionToken, region }
			: { accessKeyId, secretAccessKey, region };
		return { config, source: "environment" };
	}
	const ecsConfig = await readEcsCredentials(env);
	return ecsConfig ? { config: ecsConfig, source: "iam-role" } : null;
}

/** Credential resolution chain: stored settings -> AWS_* environment variables -> ECS container metadata. */
export async function resolveAwsCredentials(env: CloudflareEnv): Promise<AwsConfig | null> {
	return (await resolveAwsCredentialsWithSource(env))?.config ?? null;
}

/** The saved AWS credentials, falling back to AWS_* environment variables and the ECS task role. */
export async function getAwsConfig(env: CloudflareEnv): Promise<AwsConfig | null> {
	return resolveAwsCredentials(env);
}

export async function requireAwsConfig(env: CloudflareEnv): Promise<AwsConfig> {
	const config = await getAwsConfig(env);
	if (!config) throw new Error("AWS is selected but no credentials are configured");
	return config;
}

export async function getAwsConfigStatus(env: CloudflareEnv): Promise<AwsConfigStatusWithSource> {
	const stored = await readStored(env);
	const resolved = await resolveAwsCredentialsWithSource(env);
	if (!resolved) return { configured: false, source: null, region: null, accessKeyHint: null, accountId: null };
	return {
		configured: true,
		source: resolved.source,
		region: resolved.config.region,
		accessKeyHint: resolved.config.accessKeyId.slice(-4),
		accountId: stored?.accountId ?? null,
	};
}

export async function saveAwsConfig(env: CloudflareEnv, config: AwsConfig, accountId: string): Promise<void> {
	const values = { awsConfig: JSON.stringify({ ...config, accountId }), updatedAt: new Date() };
	await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
}

export async function clearAwsConfig(env: CloudflareEnv): Promise<void> {
	await getDb(env).update(appSettings).set({ awsConfig: null, updatedAt: new Date() }).where(eq(appSettings.id, "default"));
}
