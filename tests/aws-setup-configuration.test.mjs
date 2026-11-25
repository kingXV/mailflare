import assert from "node:assert/strict";
import test from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

// The Node-runtime /setup requirement checks from src/lib/setup/configuration.ts.
// The database config probe is mocked so only the mailer/DNS checks are under test.
const fixture = await loadFixture({
	name: "aws-setup-configuration",
	entryPoint: "src/lib/setup/configuration.ts",
	mocks: {
		"@/db/with-database": `export const getDatabaseConfig = () => ({ driver: "d1" });`,
	},
});
const configuration = await fixture.import();
test.after(() => fixture.dispose());

const nodeEnv = (extra = {}) => ({ MAILFLARE_RUNTIME: "node", DB: {}, EMAIL: { configured: false }, ...extra });

const checks = (env) => configuration.getSetupRequirementChecks(env);
const outboundCheck = (env) => checks(env).find((check) => check.key === "Outbound mail");
/** The DNS check is the Node-branch entry that is neither Database nor Outbound mail. */
const dnsCheck = (env) => checks(env).find((check) => check.key !== "Database" && check.key !== "Outbound mail");

test("an SES-only install without any mailer or AWS markers is not configured", () => {
	const check = outboundCheck(nodeEnv());
	assert.equal(check.configured, false);
});

test("an ECS task role counts as outbound mail being configured", () => {
	const check = outboundCheck(nodeEnv({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds" }));
	assert.equal(check.configured, true);
	assert.match(check.message, /AWS|SES/i, "the message names the detected source");
});

test("static AWS credentials with a region count as outbound mail being configured", () => {
	const check = outboundCheck(nodeEnv({ AWS_ACCESS_KEY_ID: "AKI", AWS_SECRET_ACCESS_KEY: "sec", AWS_REGION: "us-east-1" }));
	assert.equal(check.configured, true);
});

test("a region alone must not claim SES credentials", () => {
	const check = outboundCheck(nodeEnv({ AWS_REGION: "us-east-1" }));
	assert.equal(check.configured, false);
});

test("a Resend API key counts as outbound mail being configured", () => {
	const check = outboundCheck(nodeEnv({ RESEND_API_KEY: "re_test" }));
	assert.equal(check.configured, true);
});

test("a configured mailer keeps counting as configured", () => {
	const check = outboundCheck(nodeEnv({ EMAIL: { configured: true } }));
	assert.equal(check.configured, true);
});

test("the DNS check names Cloudflare when its credentials are set", () => {
	const check = dnsCheck(nodeEnv({ CF_TOKEN: "tok" }));
	assert.equal(check.configured, true);
	assert.match(check.message, /Cloudflare/);
});

test("the DNS check names Route 53 when only AWS credentials are available", () => {
	const check = dnsCheck(nodeEnv({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds", AWS_REGION: "us-east-1" }));
	assert.match(check.message, /Route 53/);
});

test("the DNS check stays manual when neither Cloudflare nor AWS is configured", () => {
	const check = dnsCheck(nodeEnv());
	assert.match(check.message, /by hand/);
});

test("the requirement checks stay synchronous", () => {
	const result = checks(nodeEnv({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds" }));
	assert.ok(Array.isArray(result), "the builder returns the checks directly, not a promise");
});

test("the Workers branch keeps its own two checks", () => {
	const result = checks({ CF_TOKEN: "tok" });
	assert.deepEqual(result.map((check) => check.key), ["Cloudflare API credentials", "D1 database"]);
	assert.equal(result[0].configured, true);
});
