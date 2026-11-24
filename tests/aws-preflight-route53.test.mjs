import assert from "node:assert/strict";
import test from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

// src/lib/domains/preflight.ts resolving Route 53 zones when Cloudflare
// credentials are absent. The zone lookup, the AWS credential resolver and the
// Route 53 client are all mocked; hasCloudflareCredentials/normalizeHostname
// run for real.
const awsConfig = { accessKeyId: "AKI", secretAccessKey: "s", region: "us-east-1" };
const fixture = await loadFixture({
	name: "aws-preflight-route53",
	entryPoint: "src/lib/domains/preflight.ts",
	mocks: {
		"@/lib/domains/provision": `export const MANUAL_ZONE_ID = "manual";`,
		"@/lib/cloudflare-api": `
			const state = (globalThis.__pf = globalThis.__pf ?? {});
			state.cf = state.cf ?? [];
			export async function findZoneByHostname(env, hostname) { state.cf.push(hostname); return env.__cfZone ?? null; }
		`,
		"@/lib/aws/config": `
			const state = (globalThis.__pf = globalThis.__pf ?? {});
			state.aws = state.aws ?? [];
			export async function getAwsConfig(env) { state.aws.push(1); return state.awsResult ?? null; }
		`,
		"@/lib/aws/route53": `
			const state = (globalThis.__pf = globalThis.__pf ?? {});
			state.r53 = state.r53 ?? [];
			export async function findRoute53ZoneByHostname(config, hostname) { state.r53.push(hostname); return state.zone ?? null; }
		`,
	},
});
const preflight = await fixture.import();
test.after(() => fixture.dispose());

const state = () => globalThis.__pf;
const reset = () => {
	const current = globalThis.__pf ?? {};
	current.cf = [];
	current.aws = [];
	current.r53 = [];
	current.zone = null;
	current.awsResult = null;
};

test("first-run setup resolves the Route 53 zone when Cloudflare credentials are absent", async () => {
	reset();
	state().zone = { id: "Z123", name: "example.com" };
	state().awsResult = awsConfig;
	const result = await preflight.preflightSetupDomain({}, "Sub.Example.com");
	assert.deepEqual(result, { hostname: "sub.example.com", zone: { id: "r53:Z123", name: "example.com" } });
	assert.deepEqual(state().r53, ["sub.example.com"], "the normalized hostname is looked up");
	assert.deepEqual(state().cf, [], "the Cloudflare zone API is never called");
});

test("first-run setup falls back to the manual zone when no Route 53 zone matches", async () => {
	reset();
	state().zone = null;
	state().awsResult = awsConfig;
	const result = await preflight.preflightSetupDomain({}, "example.com");
	assert.deepEqual(result, { hostname: "example.com", zone: { id: "manual", name: "example.com" } });
});

test("first-run setup stays manual when AWS credentials are absent too, without calling Route 53", async () => {
	reset();
	state().awsResult = null;
	const result = await preflight.preflightSetupDomain({}, "example.com");
	assert.deepEqual(result, { hostname: "example.com", zone: { id: "manual", name: "example.com" } });
	assert.deepEqual(state().r53, []);
});

test("adding a domain resolves the Route 53 zone for AWS-only installs", async () => {
	reset();
	state().zone = { id: "Z123", name: "example.com" };
	state().awsResult = awsConfig;
	const result = await preflight.preflightDomain({}, "example.com");
	assert.deepEqual(result, { hostname: "example.com", zone: { id: "r53:Z123", name: "example.com" } });
});

test("adding a domain throws Zone-not-found when AWS is configured but the zone is missing", async () => {
	reset();
	state().zone = null;
	state().awsResult = awsConfig;
	await assert.rejects(() => preflight.preflightDomain({}, "example.com"), /Zone not found/);
});

test("Cloudflare credentials keep the Cloudflare zone path even when AWS is configured", async () => {
	reset();
	state().zone = { id: "Z123", name: "example.com" };
	state().awsResult = awsConfig;
	const env = { CF_TOKEN: "tok", __cfZone: { id: "cf-zone-1", name: "example.com" } };
	const setup = await preflight.preflightSetupDomain(env, "example.com");
	assert.deepEqual(setup.zone, { id: "cf-zone-1", name: "example.com" });
	const add = await preflight.preflightDomain(env, "example.com");
	assert.deepEqual(add.zone, { id: "cf-zone-1", name: "example.com" });
	assert.deepEqual(state().r53, [], "Route 53 is never consulted when Cloudflare manages DNS");
	assert.deepEqual(state().cf, ["example.com", "example.com"]);
});

test("a skipped-DNS setup never calls any zone API", async () => {
	reset();
	const env = { CF_TOKEN: "tok", __cfZone: { id: "cf-zone-1", name: "example.com" } };
	const result = await preflight.preflightSetupDomain(env, "example.com", { skipDns: true });
	assert.deepEqual(result, { hostname: "example.com", zone: { id: "manual", name: "example.com" } });
	assert.deepEqual(state().cf, []);
	assert.deepEqual(state().r53, []);
});
