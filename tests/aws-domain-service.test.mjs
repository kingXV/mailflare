import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// addDomainForUser/removeDomainForUser from src/lib/domains/service.ts against
// the real SQLite schema. Every Cloudflare-facing API is mocked and recorded,
// so the r53 defaults and the removal-path skip are directly observable.
const { app, newDatabase } = await loadApp("aws-domain-service", `export { addDomainForUser, removeDomainForUser } from "./src/lib/domains/service.ts";`, {
	mocks: {
		"@/lib/mailboxes/domain-addresses": `export const ensureMailboxDomainRouting = async () => null;`,
		"@/lib/mailboxes/audit": `export const createAuditLog = async () => {};`,
		"@/lib/cloudflare-api": `
			const state = (globalThis.__svc = globalThis.__svc ?? {});
			state.cf = state.cf ?? [];
			export async function disableEmailRouting(env, zoneId) { state.cf.push({ fn: "disableEmailRouting", zoneId }); }
			export async function getEmailRoutingDns(env, zoneId) { return { records: [], missing: [], status: "route53" }; }
			export async function getEmailRoutingSettings(env, zoneId) { return { enabled: false, status: "route53" }; }
			export async function getSendingSubdomainDns(env, zoneId, tag) { return []; }
			export async function deleteSendingSubdomain(env, zoneId, tag) { state.cf.push({ fn: "deleteSendingSubdomain", zoneId, tag }); }
			export async function listSendingSubdomains(env, zoneId) { return []; }
		`,
		"@/lib/domains/cloudflare-cleanup": `
			const state = (globalThis.__svc = globalThis.__svc ?? {});
			state.cf = state.cf ?? [];
			export async function deleteEmailRoutingRulesForDomain(env, zoneId, hostname) { state.cf.push({ fn: "deleteEmailRoutingRules", zoneId, hostname }); }
		`,
		"@/lib/domains/provision": `
			const state = (globalThis.__svc = globalThis.__svc ?? {});
			export const MANUAL_ZONE_ID = "manual";
			export function isManualZone(zoneId) { return zoneId === MANUAL_ZONE_ID; }
			export async function provisionDomainOnCloudflare(env, hostname, options) { return state.provisioned; }
		`,
		"@/lib/domains/preflight": `
			const state = (globalThis.__svc = globalThis.__svc ?? {});
			state.preflight = state.preflight ?? 0;
			export async function preflightDomain(env, hostname) {
				state.preflight += 1;
				return state.preflightResult ?? { hostname, zone: { id: "r53:Z123", name: hostname } };
			}
		`,
		"@/lib/domains/sending-status": `export const findSendingSubdomain = () => null;`,
		"@/lib/domains/manual-dns": `export const getManualDomainDns = async () => ({ routing: { records: [], missing: [] }, sending: [], sendingEnabled: false });`,
		"@/lib/domains/rollback": `export const rollbackDomainProvisioning = async () => {};`,
		"@/lib/deliverability/mta-sts-guard": `
			const state = (globalThis.__svc = globalThis.__svc ?? {});
			state.guardCalls = state.guardCalls ?? 0;
			export class ForceDeleteConfirmError extends Error { status = 400; }
			export async function assertDomainRemovable(env, domain) { state.guardCalls += 1; }
			export async function assertMxChangeAllowed() {}
			export async function republishMtaStsAfterMxChange() {}
			export async function forceCleanupMtaSts() { return { leftovers: [], cachedUntil: null }; }
		`,
		"@/lib/cloudflare-dns": `export const isRoute53Zone = (zoneId) => typeof zoneId === "string" && zoneId.startsWith("r53:");`,
	},
});

const state = () => globalThis.__svc;
const reset = () => {
	const current = globalThis.__svc ?? {};
	current.cf = [];
	current.guardCalls = 0;
	current.preflight = 0;
	current.provisioned = null;
	current.preflightResult = null;
};

const provisionedR53 = (hostname) => ({
	hostname,
	zone: { id: "r53:Z123", name: "example.com" },
	routingEnabled: false,
	sendingRequested: true,
	sendingEnabled: false,
	sendingSubdomainTag: null,
	routingStatus: "route53",
	changes: { zoneId: "r53:Z123", enabledEmailRouting: false, createdSendingSubdomainTag: null, previousCatchAll: null, createdAddressRules: [], deletedMxRecords: [] },
});

const seedUsers = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('u1', 'u1@example.com', 'hash', 'U1', 'user', 1),
		('owner', 'owner@example.com', 'hash', 'Owner', 'user', 1);
`;

/** AWS env vars so any credential gate on the add flow sees an SES-capable install. */
const withAwsEnv = (env) => ({ ...env, AWS_ACCESS_KEY_ID: "AKI", AWS_SECRET_ACCESS_KEY: "sec", AWS_REGION: "us-east-1" });

test("a domain added on an r53 zone defaults its providers to ses", async (t) => {
	reset();
	state().provisioned = provisionedR53("example.com");
	const { env } = await newDatabase(t, seedUsers);
	const result = await app.addDomainForUser(withAwsEnv(env), "u1", "example.com");
	assert.equal(state().preflight, 1, "the zone preflight runs even without Cloudflare credentials");
	assert.equal(result.domain.zoneId, "r53:Z123");
	assert.equal(result.domain.receivingProvider, "ses");
	assert.equal(result.domain.sendingProvider, "ses");
	assert.equal(result.domain.routingStatus, "route53");
	assert.equal(result.domain.status, "active");
});

test("explicit provider options still win over the ses defaults", async (t) => {
	reset();
	state().provisioned = provisionedR53("example2.com");
	const { env } = await newDatabase(t, seedUsers);
	const result = await app.addDomainForUser(withAwsEnv(env), "u1", "example2.com", { receivingProvider: "resend", sendingProvider: "resend" });
	assert.equal(result.domain.receivingProvider, "resend");
	assert.equal(result.domain.sendingProvider, "resend");
});

test("another user's r53 zone cannot be claimed", async (t) => {
	reset();
	state().provisioned = provisionedR53("u1-example.com");
	const seed = `${seedUsers}
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d-owner', 'owner', 'owner.example.com', 'r53:Z123', 'active', 1);
	`;
	const { env, sqlite } = await newDatabase(t, seed);
	await assert.rejects(() => app.addDomainForUser(withAwsEnv(env), "u1", "u1-example.com"), /registered/i);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM domains WHERE user_id = 'u1'").get().n, 0, "nothing was inserted");
});

test("removing an r53 domain skips Cloudflare cleanup but still runs the DNS-record guard and deletes the row", async (t) => {
	reset();
	const seed = `${seedUsers}
		INSERT INTO domains (id, user_id, hostname, zone_id, status, receiving_provider, sending_provider, routing_enabled, sending_subdomain_tag, created_at)
			VALUES ('d-r53', 'u1', 'gone.example.com', 'r53:Z123', 'active', 'ses', 'ses', 1, 'tag-1', 1);
	`;
	const { env, sqlite } = await newDatabase(t, seed);
	const cleanup = await app.removeDomainForUser(env, "u1", "d-r53");
	assert.deepEqual(cleanup, { leftovers: [], cachedUntil: null });
	assert.ok(state().guardCalls >= 1, "the MTA-STS/TLS-RPT guard still runs, so DNS records are still cleared through the dispatched seam");
	assert.deepEqual(state().cf, [], "no Cloudflare routing-rule, routing-disable or sending-subdomain cleanup for an r53 zone");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM domains WHERE id = 'd-r53'").get().n, 0, "the domain row is gone");
});
