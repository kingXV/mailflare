import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-validate-"));
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

const validate = await bundle("src/lib/aws/validate.ts", "validate.mjs");

const creds = { accessKeyId: "AKIAEXAMPLE000000000", secretAccessKey: "x".repeat(40), region: "us-east-1" };

function mockAws(handler) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
		const body = typeof init.body === "string" ? init.body : "";
		const action = new URLSearchParams(body).get("Action") ?? "";
		calls.push({ url, action, body });
		const result = handler({ url, action, body });
		return new Response(result.body, { status: result.status ?? 200 });
	};
	return { calls, restore: () => { globalThis.fetch = original; } };
}

// Every probe answers success except the one under test.
const allFine = (route53) => ({ url, action }) => {
	if (action === "GetCallerIdentity") return { body: "<R><Account>111122223333</Account><Arn>arn:aws:iam::111122223333:user/x</Arn></R>" };
	if (url.pathname === "/v2/email/account") return { body: JSON.stringify({ ProductionAccessEnabled: false, SendingEnabled: true }) };
	if (action === "DescribeActiveReceiptRuleSet") return { body: "<R/>" };
	if (action === "ListTopics") return { body: "<ListTopicsResponse/>" };
	if (url.host.startsWith("s3.")) return { body: "<ListAllMyBucketsResult/>" };
	return route53({ url, action });
};

test("a healthy Route 53 probe reports route53: true", async () => {
	const mock = mockAws(allFine(() => ({ body: "<ListHostedZonesResponse><HostedZones></HostedZones></ListHostedZonesResponse>" })));
	try {
		const report = await validate.validateAwsConfig(creds);
		assert.equal(report.accountId, "111122223333");
		assert.equal(report.sending, true);
		assert.equal(report.sns, true);
		assert.equal(report.s3, true);
		assert.equal(report.route53, true);
		assert.ok(!report.missing.some((action) => action.startsWith("route53:")));
		assert.ok(mock.calls.some((call) => call.url.host === "route53.amazonaws.com"));
	} finally { mock.restore(); }
});

test("an AccessDenied Route 53 probe reports route53: false and lists the missing actions", async () => {
	const mock = mockAws(allFine(() => ({ status: 403, body: "<ErrorResponse><Error><Code>AccessDenied</Code><Message>no</Message></Error></ErrorResponse>" })));
	try {
		const report = await validate.validateAwsConfig(creds);
		assert.equal(report.route53, false);
		assert.ok(report.missing.some((action) => /^route53:List/.test(action)), JSON.stringify(report.missing));
		assert.ok(report.missing.includes("route53:ChangeResourceRecordSets"), JSON.stringify(report.missing));
	} finally { mock.restore(); }
});

test("a network-failing Route 53 probe still throws", async () => {
	const mock = mockAws(allFine(() => { throw new Error("route53 unreachable"); }));
	try {
		await assert.rejects(() => validate.validateAwsConfig(creds), /route53 unreachable/);
	} finally { mock.restore(); }
});

test("the IAM policy grants the five Route 53 actions", () => {
	const actions = validate.AWS_IAM_POLICY.Statement.flatMap((statement) => statement.Action);
	for (const action of [
		"route53:ListHostedZones",
		"route53:ListHostedZonesByName",
		"route53:GetHostedZone",
		"route53:ListResourceRecordSets",
		"route53:ChangeResourceRecordSets",
	]) {
		assert.ok(actions.includes(action), action);
	}
});
