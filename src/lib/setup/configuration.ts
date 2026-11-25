import { getDatabaseConfig } from "@/db/with-database";
import { hasCloudflareCredentials, isNodeRuntime } from "@/lib/runtime";
import type { SetupRequirementCheck } from "./types";

export function getSetupRequirementChecks(env: CloudflareEnv): SetupRequirementCheck[] {
	const hasApiToken = !!env.CF_TOKEN?.trim();
	const hasGlobalKey = !!env.CF_API_KEY?.trim() && !!env.CF_EMAIL?.trim();

	const database = getDatabaseConfig(env);
	if (isNodeRuntime(env)) {
		const mailer = env.EMAIL as unknown as { configured?: boolean };
		const awsEnv = env as Partial<Record<"AWS_ACCESS_KEY_ID" | "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" | "RESEND_API_KEY", string>>;
		const awsCredsDetected = !!awsEnv.AWS_ACCESS_KEY_ID?.trim() || !!awsEnv.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
		const resendConfigured = !!awsEnv.RESEND_API_KEY?.trim();
		return [
			{
				key: "Database",
				configured: !!env.DB,
				message: database.driver === "d1" ? "DATA_DIR must be writable; the SQLite database is created there on start." : "DATABASE_URL must be reachable; migrations are applied on start.",
			},
			{
				key: "Outbound mail",
				configured: mailer?.configured === true || awsCredsDetected || resendConfigured,
				message: mailer?.configured === true
					? "Outbound mail goes through the configured SMTP_URL or Cloudflare mailer."
					: awsCredsDetected
						? "AWS/SES credentials detected; sending also needs a verified identity in a supported region."
						: resendConfigured
							? "RESEND_API_KEY is set; outbound mail goes through Resend."
							: "Set SMTP_URL, or CF_ACCOUNT_ID with CF_TOKEN to send through Cloudflare. Receiving works without it.",
			},
			{
				key: "Cloudflare API credentials (optional)",
				configured: true,
				message: hasCloudflareCredentials(env)
					? "Domains are provisioned on Cloudflare automatically."
					: awsCredsDetected
						? "Domains are provisioned on Route 53 automatically."
						: "Not set: add MX and SPF records for each domain by hand, as shown on the domain page.",
			},
		];
	}

	return [
		{
			key: "Cloudflare API credentials",
			configured: hasApiToken || hasGlobalKey,
			message: "Set CF_TOKEN, or set both CF_API_KEY and CF_EMAIL.",
		},
		{
			key: database.driver === "d1" ? "D1 database" : "Database",
			configured: !!env.DB,
			message: database.driver === "d1" ? "Deploy the Worker with the DB binding from wrangler.jsonc." : "Check DATABASE_URL (and DATABASE_DRIVER) for the external database.",
		},
	];
}
