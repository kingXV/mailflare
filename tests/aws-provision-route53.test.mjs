import assert from "node:assert/strict";
import test from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

// provisionDomainOnCloudflare from src/lib/domains/provision.ts recording a
// Route 53 zone instead of "manual" on AWS-only installs. Every Cloudflare and
// AWS API the function reaches for is mocked and recorded.
const awsConfig = { accessKeyId: "AKI", secretAccessKey: "s", region: "us-east-1" };
const fixture = await loadFixture({
	name: "aws-provision-route53",
	entryPoint: "src/lib/domains/provision.ts",
	mocks: {
		"@/lib/cloudflare-api": `
			const state = (globalThis.__prov = globalThis.__prov ?? {});
			state.cf = state.cf ?? [];
			export async function findZoneByHostname(env, hostname) { state.cf.push("findZone:" + hostname); return state.cfZone ?? null; }
			export async function getEmailRoutingSettings(env, zoneId) { state.cf.push("routingSettings:" + zoneId); return { enabled: false }; }
			export async function enableEmailRouting(env, zoneId, name) { state.cf.push("enableRouting:" + zoneId); return { enabled: true, status: "active" }; }
		`,
		"@/lib/domains/catch-all-routing": `
			const state = (globalThis.__prov = globalThis.__prov ?? {});
			state.catchAll = state.catchAll ?? [];
			export async function getEmailRoutingCatchAll(env, zoneId) { state.catchAll.push("get"); return null; }
			export async function ensureEmailRoutingCatchAllToWorker(env, zoneId) { state.catchAll.push("ensure"); }
		`,
		"@/lib/domains/mx-records": `
			const state = (globalThis.__prov = globalThis.__prov ?? {});
			state.cf = state.cf ?? [];
			export async function removeMxRecords(env, zoneId, name, deleted) { state.cf.push("removeMx:" + zoneId); }
		`,
		"@/lib/domains/rollback": `export async function rollbackDomainProvisioning() {}`,
		"@/lib/domains/sending-subdomain": `
			const state = (globalThis.__prov = globalThis.__prov ?? {});
			state.sending = state.sending ?? [];
			export async function ensureSendingSubdomain(env, zoneId, hostname, options) { state.sending.push(zoneId); return { subdomain: { tag: "sub-tag", enabled: true }, created: true }; }
		`,
		"@/lib/aws/config": `
			const state = (globalThis.__prov = globalThis.__prov ?? {});
			state.aws = state.aws ?? 0;
			export async function getAwsConfig(env) { state.aws += 1; return state.awsResult ?? null; }
		`,
		"@/lib/aws/route53": `
			const state = (globalThis.__prov = globalThis.__prov ?? {});
			state.r53 = state.r53 ?? [];
			export async function findRoute53ZoneByHostname(config, hostname) { state.r53.push(hostname); return state.zone ?? null; }
		`,
	},
});
const provision = await fixture.import();
test.after(() => fixture.dispose());

const state = () => globalThis.__prov;
const reset = () => {
	const current = globalThis.__prov ?? {};
	current.cf = [];
	current.catchAll = [];
	current.sending = [];
	current.r53 = [];
	current.aws = 0;
	current.zone = null;
	current.awsResult = null;
	current.cfZone = null;
};

test("an AWS-only install records the Route 53 zone and skips every Cloudflare step", async () => {
	reset();
	state().zone = { id: "Z123", name: "example.com" };
	state().awsResult = awsConfig;
	const result = await provision.provisionDomainOnCloudflare({}, "Example.com");
	assert.deepEqual(result.zone, { id: "r53:Z123", name: "example.com" });
	assert.equal(result.hostname, "example.com");
	assert.equal(result.routingStatus, "route53");
	assert.equal(result.routingEnabled, true);
	assert.equal(result.sendingEnabled, false);
	assert.equal(result.sendingSubdomainTag, null);
	assert.deepEqual(result.changes, { zoneId: "r53:Z123", enabledEmailRouting: false, createdSendingSubdomainTag: null, previousCatchAll: null, createdAddressRules: [], deletedMxRecords: [] });
	assert.deepEqual(state().r53, ["example.com"]);
	assert.deepEqual(state().cf, [], "no Cloudflare API is called");
	assert.deepEqual(state().catchAll, []);
	assert.deepEqual(state().sending, []);
});

test("the r53 result mirrors an explicit enableRouting: false", async () => {
	reset();
	state().zone = { id: "Z123", name: "example.com" };
	state().awsResult = awsConfig;
	const result = await provision.provisionDomainOnCloudflare({}, "example.com", { enableRouting: false });
	assert.equal(result.routingEnabled, false);
	assert.equal(result.routingStatus, "route53");
});

test("an AWS-only install without a matching hosted zone falls back to the manual result", async () => {
	reset();
	state().zone = null;
	state().awsResult = awsConfig;
	const result = await provision.provisionDomainOnCloudflare({}, "example.com");
	assert.deepEqual(result.zone, { id: "manual", name: "example.com" });
	assert.equal(result.routingStatus, "manual");
});

test("skipDns stays manual even when a Route 53 zone would match", async () => {
	reset();
	state().zone = { id: "Z123", name: "example.com" };
	state().awsResult = awsConfig;
	const result = await provision.provisionDomainOnCloudflare({}, "example.com", { skipDns: true });
	assert.deepEqual(result.zone, { id: "manual", name: "example.com" });
	assert.deepEqual(state().r53, [], "Route 53 is never queried when DNS is skipped");
});

test("Cloudflare credentials keep the Cloudflare provisioning path even when AWS is also configured", async () => {
	reset();
	state().cfZone = { id: "cf-zone-1", name: "example.com" };
	state().awsResult = awsConfig;
	const result = await provision.provisionDomainOnCloudflare({ CF_TOKEN: "tok" }, "example.com");
	assert.deepEqual(result.zone, { id: "cf-zone-1", name: "example.com" });
	assert.equal(result.routingStatus, "active");
	assert.equal(result.sendingSubdomainTag, "sub-tag");
	assert.ok(state().cf.length > 0, "the Cloudflare API is used");
	assert.deepEqual(state().r53, [], "Route 53 is never queried when Cloudflare manages the zone");
});

test("no credentials at all keeps the manual result", async () => {
	reset();
	state().awsResult = null;
	const result = await provision.provisionDomainOnCloudflare({}, "example.com");
	assert.deepEqual(result.zone, { id: "manual", name: "example.com" });
	assert.equal(result.routingStatus, "manual");
	assert.deepEqual(state().r53, []);
});
