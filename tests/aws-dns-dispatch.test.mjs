import assert from "node:assert/strict";
import test from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

// src/lib/cloudflare-dns.ts dispatching r53: zone ids to the Route 53 client.
// Both backends are mocked so the dispatch (and only the dispatch) is under
// test; the Cloudflare path is pinned to its current request shapes.
const stubConfig = { accessKeyId: "AKI", secretAccessKey: "s", region: "us-east-1" };
const fixture = await loadFixture({
	name: "aws-dns-dispatch",
	entryPoint: "src/lib/cloudflare-dns.ts",
	mocks: {
		"@/lib/cloudflare-api": `
			const state = (globalThis.__dnsDispatch = globalThis.__dnsDispatch ?? {});
			state.cf = state.cf ?? [];
			export async function cfRequest(env, path, init) { state.cf.push({ path, init }); return init?.method === "DELETE" ? undefined : { id: "cf-rec-1", type: "TXT", name: "host.example.com", content: "cloudflare-value", ttl: 300 }; }
		`,
		"@/lib/aws/config": `
			const state = (globalThis.__dnsDispatch = globalThis.__dnsDispatch ?? {});
			state.aws = state.aws ?? { calls: 0, fail: false };
			export async function requireAwsConfig(env) {
				state.aws.calls += 1;
				if (state.aws.fail) throw new Error("AWS is selected but no credentials are configured");
				return ${JSON.stringify(stubConfig)};
			}
			export async function getAwsConfig() { return ${JSON.stringify(stubConfig)}; }
		`,
		"@/lib/aws/route53": `
			const state = (globalThis.__dnsDispatch = globalThis.__dnsDispatch ?? {});
			state.r53 = state.r53 ?? [];
			export async function listRoute53Records(config, zoneId, params) {
				state.r53.push({ fn: "list", config, zoneId, params });
				return [{ id: "r53:TXT:host.example.com:hash", type: params.type, name: params.name, content: "route53-value", ttl: 300 }];
			}
			export async function createRoute53Record(config, zoneId, params) {
				state.r53.push({ fn: "create", config, zoneId, params });
				return { id: "r53:TXT:host.example.com:hash2", type: params.type, name: params.name, content: params.content, ttl: params.ttl };
			}
			export async function deleteRoute53Record(config, zoneId, recordId) {
				state.r53.push({ fn: "delete", config, zoneId, recordId });
			}
			export async function updateRoute53Record(config, zoneId, recordId, changes) {
				state.r53.push({ fn: "update", config, zoneId, recordId, changes });
				return { id: "r53:TXT:host.example.com:hash3", type: "TXT", name: "host.example.com", content: changes.content, ttl: changes.ttl };
			}
		`,
	},
});
const dns = await fixture.import();
test.after(() => fixture.dispose());

const state = () => globalThis.__dnsDispatch;
// Reset in place (the bundled mocks captured the state object at import time)
// and tolerate keys whose owning mock module is not loaded yet.
const reset = () => {
	const current = globalThis.__dnsDispatch ?? {};
	current.cf = [];
	current.r53 = [];
	current.aws = { calls: 0, fail: false };
};

test("listMxRecords delegates an r53 zone to the Route 53 client with the resolved config", async () => {
	reset();
	const records = await dns.listMxRecords({}, "r53:Z123", "mail.example.com");
	assert.deepEqual(state().r53, [{ fn: "list", config: stubConfig, zoneId: "r53:Z123", params: { type: "MX", name: "mail.example.com" } }]);
	assert.deepEqual(state().cf, [], "the Cloudflare API is never called for an r53 zone");
	assert.deepEqual(records, [{ id: "r53:TXT:host.example.com:hash", type: "MX", name: "mail.example.com", content: "route53-value", ttl: 300 }]);
});

test("listDnsRecords delegates an r53 zone with the requested type and name", async () => {
	reset();
	await dns.listDnsRecords({}, "r53:Z123", { type: "TXT", name: "_dmarc.example.com" });
	assert.deepEqual(state().r53[0].params, { type: "TXT", name: "_dmarc.example.com" });
	assert.deepEqual(state().cf, []);
});

test("deleteDnsRecord delegates the synthetic record id untouched", async () => {
	reset();
	const recordId = "r53:TXT:_dmarc.example.com:AbCdEf";
	await dns.deleteDnsRecord({}, "r53:Z123", recordId);
	assert.deepEqual(state().r53, [{ fn: "delete", config: stubConfig, zoneId: "r53:Z123", recordId }]);
	assert.deepEqual(state().cf, []);
});

test("createDnsRecord delegates MX records with their priority", async () => {
	reset();
	const record = await dns.createDnsRecord({}, "r53:Z123", { type: "MX", name: "example.com", content: "inbound.example.com", priority: 10, ttl: 300 });
	assert.deepEqual(state().r53[0].params, { type: "MX", name: "example.com", content: "inbound.example.com", priority: 10, ttl: 300 });
	assert.equal(record.id, "r53:TXT:host.example.com:hash2");
	assert.deepEqual(state().cf, []);
});

test("updateDnsRecord delegates the content and ttl changes", async () => {
	reset();
	const record = await dns.updateDnsRecord({}, "r53:Z123", "r53:TXT:host.example.com:hash", { content: "v=spf2", ttl: 60 });
	assert.deepEqual(state().r53[0].changes, { content: "v=spf2", ttl: 60 });
	assert.equal(record.content, "v=spf2");
	assert.deepEqual(state().cf, []);
});

test("Cloudflare zone ids keep the existing request shapes for all five functions", async () => {
	reset();
	await dns.listMxRecords({}, "zone-abc", "mail.example.com");
	await dns.listDnsRecords({}, "zone-abc", { type: "TXT", name: "_dmarc.example.com" });
	await dns.deleteDnsRecord({}, "zone-abc", "rec-1");
	await dns.createDnsRecord({}, "zone-abc", { type: "TXT", name: "host.example.com", content: "v=spf1", ttl: 300 });
	await dns.updateDnsRecord({}, "zone-abc", "rec-1", { content: "v=spf2" });
	assert.deepEqual(state().r53, [], "no Route 53 call happens for a Cloudflare zone id");
	assert.deepEqual(state().cf.map((call) => call.path), [
		"/zones/zone-abc/dns_records?type=MX&name=mail.example.com&per_page=5000",
		"/zones/zone-abc/dns_records?type=TXT&name=_dmarc.example.com&per_page=5000",
		"/zones/zone-abc/dns_records/rec-1",
		"/zones/zone-abc/dns_records",
		"/zones/zone-abc/dns_records/rec-1",
	]);
	assert.deepEqual(state().cf.map((call) => call.init?.method), [undefined, undefined, "DELETE", "POST", "PATCH"]);
	assert.deepEqual(JSON.parse(state().cf[3].init.body), { type: "TXT", name: "host.example.com", content: "v=spf1", ttl: 300 });
	assert.deepEqual(JSON.parse(state().cf[4].init.body), { content: "v=spf2" }, "a TTL-less update sends content only");
});

test("a missing AWS configuration surfaces the requireAwsConfig error, never a Cloudflare fallback", async () => {
	reset();
	state().aws.fail = true;
	await assert.rejects(
		() => dns.createDnsRecord({}, "r53:Z123", { type: "TXT", name: "host.example.com", content: "v=spf1", ttl: 300 }),
		/no credentials are configured/,
	);
	assert.deepEqual(state().cf, []);
});
