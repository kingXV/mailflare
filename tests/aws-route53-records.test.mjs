import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src/lib/aws/route53.ts");
// Task 003 creates this module. Until it exists, fail on the module import
// itself (the expected red state) rather than on a bundling error.
if (!existsSync(source)) await import(pathToFileURL(source).href);

const outDir = mkdtempSync(join(tmpdir(), "mailflare-route53-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const route53 = await bundle("src/lib/aws/route53.ts", "route53.mjs");
const xml = await bundle("src/lib/aws/xml.ts", "xml.mjs");

const config = { accessKeyId: "AKIAEXAMPLE000000000", secretAccessKey: "x".repeat(40), region: "us-east-1" };
/** Route 53 zone ids as stored by the app, prefix included; the client strips it for the wire path. */
const zone = "r53:Z123";

// The synthetic id contract: r53:<type>:<fqdn>:<base64url(sha1(rawValue))>.
const recordId = (type, name, value) => `r53:${type}:${name}:${createHash("sha1").update(value).digest("base64url")}`;

const zoneByNameXml = (found) => found
	? `<ListHostedZonesByNameResponse><HostedZones><HostedZone><Id>/hostedzone/${found.id}</Id><Name>${found.name}</Name><Config><PrivateZone>${found.private ? "true" : "false"}</PrivateZone></Config></HostedZone></HostedZones><IsTruncated>false</IsTruncated></ListHostedZonesByNameResponse>`
	: `<ListHostedZonesByNameResponse><HostedZones></HostedZones><IsTruncated>false</IsTruncated></ListHostedZonesByNameResponse>`;

const setXml = (set) => {
	const records = (set.values ?? []).map((value) => `<ResourceRecord><Value>${value}</Value></ResourceRecord>`).join("");
	const inner = set.alias
		? `<AliasTarget><HostedZoneId>ZHOST</HostedZoneId><DNSName>${set.alias}</DNSName></AliasTarget>`
		: `<ResourceRecords>${records}</ResourceRecords>`;
	return `<ResourceRecordSet><Name>${set.name}</Name><Type>${set.type}</Type><TTL>${set.ttl ?? 300}</TTL>${inner}</ResourceRecordSet>`;
};

const rrsetsXml = (sets) => `<ListResourceRecordSetsResponse><ResourceRecordSets>${sets.map(setXml).join("")}</ResourceRecordSets><IsTruncated>false</IsTruncated></ListResourceRecordSetsResponse>`;

function mockRoute53(scenario) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
		const method = init.method ?? "GET";
		const call = { url, method, body: typeof init.body === "string" ? init.body : "", headers: init.headers ?? {} };
		calls.push(call);
		if (method === "GET" && url.pathname.endsWith("/hostedzonesbyname")) {
			const name = (url.searchParams.get("dnsname") ?? "").replace(/\.$/, "");
			return new Response(zoneByNameXml(scenario.zones?.[name] ?? null), { status: 200 });
		}
		if (method === "GET" && /\/hostedzone\/[^/]+\/rrset$/.test(url.pathname)) {
			return new Response(rrsetsXml(scenario.rrsets ?? []), { status: 200 });
		}
		if (method === "POST" && /\/hostedzone\/[^/]+\/rrset$/.test(url.pathname)) {
			return new Response("<ChangeResourceRecordSetsResponse><ChangeInfo><Id>/change/C1</Id><Status>PENDING</Status></ChangeInfo></ChangeResourceRecordSetsResponse>", { status: 200 });
		}
		return new Response("<ErrorResponse><Error><Code>NotFound</Code></Error></ErrorResponse>", { status: 404 });
	};
	return { calls, restore: () => { globalThis.fetch = original; } };
}

/** ChangeBatch requests, parsed back out of the XML the client sent. */
function changes(mock) {
	return xml.xmlBlocks(mock.calls.at(-1).body, "Change").map((block) => ({
		action: xml.xmlTag(block, "Action"),
		name: xml.xmlTag(block, "Name"),
		type: xml.xmlTag(block, "Type"),
		ttl: xml.xmlTag(block, "TTL"),
		values: xml.xmlTags(block, "Value"),
	}));
}

const header = (call, name) => Object.entries(call.headers).find(([key]) => key.toLowerCase() === name)?.[1];

test("findRoute53ZoneByHostname walks parent labels to the matching public zone", async () => {
	const mock = mockRoute53({ zones: { "example.com": { id: "Z123", name: "example.com.", private: false } } });
	try {
		const found = await route53.findRoute53ZoneByHostname(config, "a.b.example.com");
		assert.deepEqual(found, { id: "Z123", name: "example.com" }, "the /hostedzone/ prefix is stripped and the name normalized");
		const lookups = mock.calls.filter((call) => call.url.pathname.endsWith("/hostedzonesbyname"));
		const queries = lookups.map((call) => call.url.searchParams.get("dnsname"));
		assert.ok(queries.includes("example.com"), JSON.stringify(queries));
		assert.ok(!queries.includes("com"), "the bare TLD is never queried");
		assert.ok(lookups.every((call) => call.url.searchParams.get("maxitems") === "1"));
		assert.equal(mock.calls[0].url.host, "route53.amazonaws.com");
		assert.match(mock.calls[0].url.pathname, /^\/2013-04-01\//);
		assert.match(header(mock.calls[0], "authorization"), /\/us-east-1\/route53\/aws4_request/);
	} finally { mock.restore(); }
});

test("findRoute53ZoneByHostname skips private zones", async () => {
	const mock = mockRoute53({ zones: { "example.com": { id: "Z123", name: "example.com.", private: true } } });
	try {
		assert.equal(await route53.findRoute53ZoneByHostname(config, "mail.example.com"), null);
	} finally { mock.restore(); }
});

test("findRoute53ZoneByHostname never matches a zone the hostname does not end with", async () => {
	const mock = mockRoute53({ zones: { "example.com": { id: "Z999", name: "notexample.com.", private: false } } });
	try {
		assert.equal(await route53.findRoute53ZoneByHostname(config, "a.b.example.com"), null);
	} finally { mock.restore(); }
});

test("listRoute53Records flattens multi-value sets into stable per-value records", async () => {
	const valueA = '"v=spf1 a ~all"';
	const valueB = '"v=spf1 b ~all"';
	const mock = mockRoute53({ rrsets: [{ name: "example.com.", type: "TXT", ttl: 3600, values: [valueA, valueB] }] });
	try {
		const first = await route53.listRoute53Records(config, zone, { type: "TXT", name: "example.com" });
		const second = await route53.listRoute53Records(config, zone, { type: "TXT", name: "example.com" });
		assert.equal(mock.calls[0].url.host, "route53.amazonaws.com");
		assert.equal(mock.calls[0].url.pathname, "/2013-04-01/hostedzone/Z123/rrset", "the r53: prefix is stripped from the zone id");
		assert.equal(mock.calls[0].url.searchParams.get("type"), "TXT");
		assert.equal(mock.calls[0].url.searchParams.get("maxitems"), "100");
		assert.ok(["example.com", "example.com."].includes(mock.calls[0].url.searchParams.get("name")));
		assert.equal(first.length, 2);
		for (const record of first) {
			assert.equal(record.type, "TXT");
			assert.equal(record.name, "example.com", "the trailing dot is stripped from record names");
			assert.equal(record.ttl, 3600);
		}
		assert.equal(first[0].id, recordId("TXT", "example.com", valueA));
		assert.equal(first[0].content, "v=spf1 a ~all");
		assert.equal(first[1].id, recordId("TXT", "example.com", valueB));
		assert.equal(first[1].content, "v=spf1 b ~all");
		assert.deepEqual(second.map((record) => record.id), first.map((record) => record.id), "the same value always yields the same id");
	} finally { mock.restore(); }
});

test("listRoute53Records splits MX values into priority and content", async () => {
	const mock = mockRoute53({ rrsets: [{ name: "example.com.", type: "MX", ttl: 300, values: ["10 inbound-1.example.com", "20 inbound-2.example.com"] }] });
	try {
		const records = await route53.listRoute53Records(config, zone, { type: "MX", name: "example.com" });
		assert.equal(records.length, 2);
		assert.equal(records[0].id, recordId("MX", "example.com", "10 inbound-1.example.com"));
		assert.equal(records[0].priority, 10);
		assert.equal(records[0].content, "inbound-1.example.com");
		assert.equal(records[1].priority, 20);
		assert.equal(records[1].content, "inbound-2.example.com");
	} finally { mock.restore(); }
});

test("listRoute53Records strips TXT quotes and joins 255-character chunks", async () => {
	const chunk1 = "x".repeat(255);
	const chunk2 = "y".repeat(45);
	const value = `"${chunk1}" "${chunk2}"`;
	const mock = mockRoute53({ rrsets: [{ name: "_dmarc.example.com.", type: "TXT", ttl: 300, values: [value] }] });
	try {
		const records = await route53.listRoute53Records(config, zone, { type: "TXT", name: "_dmarc.example.com" });
		assert.equal(records.length, 1);
		assert.equal(records[0].id, recordId("TXT", "_dmarc.example.com", value));
		assert.equal(records[0].content, chunk1 + chunk2);
	} finally { mock.restore(); }
});

test("listRoute53Records filters to the exact name and type", async () => {
	const mock = mockRoute53({ rrsets: [
		{ name: "other.example.com.", type: "TXT", ttl: 300, values: ['"nope"'] },
		{ name: "_dmarc.example.com.", type: "TXT", ttl: 300, values: ['"v=DMARC1"' ] },
		{ name: "_dmarc.example.com.", type: "CNAME", ttl: 300, values: [" cname.example.com."] },
	] });
	try {
		const records = await route53.listRoute53Records(config, zone, { type: "TXT", name: "_dmarc.example.com" });
		assert.deepEqual(records.map((record) => record.content), ["v=DMARC1"]);
	} finally { mock.restore(); }
});

test("listRoute53Records never touches alias sets", async () => {
	const mock = mockRoute53({ rrsets: [{ name: "www.example.com.", type: "A", ttl: 300, alias: "alb.example.com." }] });
	try {
		const records = await route53.listRoute53Records(config, zone, { type: "A", name: "www.example.com" });
		assert.deepEqual(records, []);
	} finally { mock.restore(); }
});

test("createRoute53Record UPSERTs a new value alongside the existing ones and returns the record", async () => {
	const mock = mockRoute53({ rrsets: [{ name: "_dmarc.example.com.", type: "TXT", ttl: 300, values: ['"old"'] }] });
	try {
		const created = await route53.createRoute53Record(config, zone, { type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1", ttl: 300 });
		const change = changes(mock)[0];
		assert.equal(change.action, "UPSERT");
		assert.equal(change.name, "_dmarc.example.com.");
		assert.equal(change.type, "TXT");
		assert.equal(change.ttl, "300");
		assert.deepEqual(change.values, ['"old"', '"v=DMARC1"'], "the new TXT value is quoted and appended");
		assert.equal(created.id, recordId("TXT", "_dmarc.example.com", '"v=DMARC1"'));
		assert.equal(created.type, "TXT");
		assert.equal(created.name, "_dmarc.example.com");
		assert.equal(created.content, "v=DMARC1");
		assert.equal(created.ttl, 300);
	} finally { mock.restore(); }
});

test("createRoute53Record does not duplicate an identical existing value", async () => {
	const mock = mockRoute53({ rrsets: [{ name: "_dmarc.example.com.", type: "TXT", ttl: 300, values: ['"v=DMARC1"'] }] });
	try {
		await route53.createRoute53Record(config, zone, { type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1", ttl: 300 });
		assert.deepEqual(changes(mock)[0].values, ['"v=DMARC1"'], "the UPSERT is idempotent");
	} finally { mock.restore(); }
});

test("createRoute53Record re-joins MX priority and content into the Route 53 value", async () => {
	const mock = mockRoute53({ rrsets: [] });
	try {
		await route53.createRoute53Record(config, zone, { type: "MX", name: "example.com", content: "inbound.example.com", ttl: 300, priority: 10 });
		const change = changes(mock)[0];
		assert.equal(change.type, "MX");
		assert.deepEqual(change.values, ["10 inbound.example.com"]);
	} finally { mock.restore(); }
});

test("createRoute53Record quotes and chunks TXT values longer than 255 characters", async () => {
	const mock = mockRoute53({ rrsets: [] });
	try {
		const content = "z".repeat(300);
		await route53.createRoute53Record(config, zone, { type: "TXT", name: "_dmarc.example.com", content, ttl: 300 });
		assert.deepEqual(changes(mock)[0].values, [`"${"z".repeat(255)}" "${"z".repeat(45)}"`]);
	} finally { mock.restore(); }
});

test("createRoute53Record XML-escapes interpolated names and values", async () => {
	const mock = mockRoute53({ rrsets: [] });
	try {
		await route53.createRoute53Record(config, zone, { type: "TXT", name: "_dmarc.example.com", content: "a&b<c", ttl: 300 });
		assert.match(mock.calls.at(-1).body, /a&amp;b&lt;c/, "special characters are escaped on the wire");
	} finally { mock.restore(); }
});

test("deleteRoute53Record removes one value from a multi-value set via UPSERT", async () => {
	const values = ["10 mx1.example.com", "10 mx2.example.com"];
	const mock = mockRoute53({ rrsets: [{ name: "example.com.", type: "MX", ttl: 300, values }] });
	try {
		await route53.deleteRoute53Record(config, zone, recordId("MX", "example.com", values[0]));
		const change = changes(mock)[0];
		assert.equal(change.action, "UPSERT");
		assert.equal(change.type, "MX");
		assert.deepEqual(change.values, ["10 mx2.example.com"]);
	} finally { mock.restore(); }
});

test("deleteRoute53Record DELETEs the set when the last value is removed", async () => {
	const mock = mockRoute53({ rrsets: [{ name: "_dmarc.example.com.", type: "TXT", ttl: 300, values: ['"only"'] }] });
	try {
		await route53.deleteRoute53Record(config, zone, recordId("TXT", "_dmarc.example.com", '"only"'));
		const change = changes(mock)[0];
		assert.equal(change.action, "DELETE");
		assert.equal(change.name, "_dmarc.example.com.");
		assert.equal(change.type, "TXT");
	} finally { mock.restore(); }
});

test("updateRoute53Record replaces the matching value in place", async () => {
	const mock = mockRoute53({ rrsets: [{ name: "example.com.", type: "TXT", ttl: 300, values: ['"a"', '"b"'] }] });
	try {
		const updated = await route53.updateRoute53Record(config, zone, recordId("TXT", "example.com", '"a"'), { content: "c", ttl: 120 });
		const change = changes(mock)[0];
		assert.equal(change.action, "UPSERT");
		assert.equal(change.ttl, "120");
		assert.ok(change.values.includes('"c"'), JSON.stringify(change.values));
		assert.ok(change.values.includes('"b"'), JSON.stringify(change.values));
		assert.ok(!change.values.includes('"a"'), "the old value is gone");
		assert.equal(updated.id, recordId("TXT", "example.com", '"c"'));
		assert.equal(updated.content, "c");
	} finally { mock.restore(); }
});
