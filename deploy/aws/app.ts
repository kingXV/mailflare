#!/usr/bin/env node
/**
 * Mailflare AWS hosting stack (CDK v2, single-file app).
 *
 * Provisions a VPC, RDS PostgreSQL 16 (private subnets), an S3 app bucket,
 * three SQS queues with dead-letter queues, an internet-facing ALB with an
 * ACM certificate and Route 53 aliases, and the ECS Fargate service running
 * Mailflare. Synthesizes without AWS credentials or lookups:
 *
 *   npm --prefix deploy/aws run synth:app
 *
 * Context (cdk.json or `cdk synth -c key=value`):
 *   hostedZoneId     Route 53 hosted zone ID (placeholder default keeps synth green)
 *   hostedZoneName   Route 53 zone name; derived from appDomain when omitted
 *   appDomain        app hostname, e.g. mail.example.com (default mail.example.com)
 *   mtaStsDomain     optional extra certificate SAN + alias, e.g. mta-sts.example.com
 *   imageRepository  container image; placeholder busybox keeps synth green without Docker
 *   dbName           RDS database name (default mailflare)
 *   multiAz          RDS Multi-AZ deployment (default false)
 *   vpcEndpoints     VPC interface/gateway endpoints instead of NAT gateways (default false)
 *   turnstileSiteKey optional TURNSTILE_SITE_KEY environment value
 */
import { Annotations, App, CfnOutput, CustomResource, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

const PLACEHOLDER_HOSTED_ZONE_ID = "Z0123456789ABCDEFGHIJ";
const PLACEHOLDER_IMAGE_REPOSITORY = "public.ecr.aws/docker/library/busybox:latest";
const DEFAULT_APP_DOMAIN = "mail.example.com";

/** Regions where SES inbound receiving (receipt rules) is available. */
const SES_RECEIVING_REGIONS = new Set([
	"us-east-1",
	"us-east-2",
	"us-west-2",
	"ap-south-1",
	"ap-southeast-1",
	"ap-southeast-2",
	"ca-central-1",
	"eu-central-1",
	"eu-west-1",
	"eu-west-2",
	"eu-west-3",
	"eu-north-1",
	"il-central-1",
	"sa-east-1",
]);

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

interface StackConfig {
	hostedZoneId: string;
	hostedZoneName: string;
	appDomain: string;
	mtaStsDomain?: string;
	imageRepository: string;
	dbName: string;
	multiAz: boolean;
	vpcEndpoints: boolean;
	turnstileSiteKey?: string;
}

/**
 * Reads one context value as a trimmed string. Returns undefined when the
 * value is absent and "" when it is present but empty, so callers can tell
 * "operator set an empty value" apart from "operator did not set it".
 */
function stringContext(stack: Stack, name: string): string | undefined {
	const value = stack.node.tryGetContext(name);
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`context ${name} must be a string, got: ${JSON.stringify(value)}`);
	const trimmed = value.trim();
	return trimmed === "" ? "" : trimmed;
}

function booleanContext(stack: Stack, name: string, fallback: boolean): boolean {
	const value = stack.node.tryGetContext(name);
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`context ${name} must be true or false, got: ${JSON.stringify(value)}`);
}

function requireHostname(name: string, value: string): void {
	if (!HOSTNAME_PATTERN.test(value)) {
		throw new Error(`context ${name} must be a DNS hostname, got: ${JSON.stringify(value)}`);
	}
}

function readConfig(stack: Stack): StackConfig {
	const appDomainRaw = stringContext(stack, "appDomain");
	const appDomain = !appDomainRaw ? DEFAULT_APP_DOMAIN : appDomainRaw;
	requireHostname("appDomain", appDomain);

	const mtaStsDomainRaw = stringContext(stack, "mtaStsDomain");
	const mtaStsDomain = !mtaStsDomainRaw ? undefined : mtaStsDomainRaw;
	if (mtaStsDomain) requireHostname("mtaStsDomain", mtaStsDomain);

	const hostedZoneIdRaw = stringContext(stack, "hostedZoneId");
	if (hostedZoneIdRaw === "") {
		throw new Error(
			"context hostedZoneId is set but empty: pass your Route 53 hosted zone ID (cdk synth -c hostedZoneId=Z1234567890ABCDEF1234) or remove the empty value to use the synth-only placeholder",
		);
	}
	const hostedZoneId = hostedZoneIdRaw === undefined ? PLACEHOLDER_HOSTED_ZONE_ID : hostedZoneIdRaw;

	const hostedZoneNameRaw = stringContext(stack, "hostedZoneName");
	let hostedZoneName = hostedZoneNameRaw ?? "";
	if (!hostedZoneName) {
		const labels = appDomain.split(".");
		if (labels.length < 3) {
			throw new Error(`cannot derive the hosted zone name from appDomain ${appDomain}; set the hostedZoneName context explicitly`);
		}
		hostedZoneName = labels.slice(1).join(".");
	}
	requireHostname("hostedZoneName", hostedZoneName);
	const zoneCovers = (domain: string) => domain === hostedZoneName || domain.endsWith(`.${hostedZoneName}`);
	if (!zoneCovers(appDomain)) {
		throw new Error(`appDomain ${appDomain} is not inside hosted zone ${hostedZoneName}; fix appDomain or set hostedZoneName`);
	}
	if (mtaStsDomain && !zoneCovers(mtaStsDomain)) {
		throw new Error(`mtaStsDomain ${mtaStsDomain} is not inside hosted zone ${hostedZoneName}`);
	}

	const imageRepositoryRaw = stringContext(stack, "imageRepository");
	const imageRepository = !imageRepositoryRaw ? PLACEHOLDER_IMAGE_REPOSITORY : imageRepositoryRaw;
	if (!/^[A-Za-z0-9._/:~-]+$/.test(imageRepository)) {
		throw new Error(`context imageRepository must look like a container image reference, got: ${JSON.stringify(imageRepository)}`);
	}

	const dbNameRaw = stringContext(stack, "dbName");
	const dbName = !dbNameRaw ? "mailflare" : dbNameRaw;
	if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) {
		throw new Error(`context dbName must be a valid PostgreSQL database name (^[a-z_][a-z0-9_]{0,62}$), got: ${JSON.stringify(dbName)}`);
	}

	const turnstileSiteKeyRaw = stringContext(stack, "turnstileSiteKey");
	const turnstileSiteKey = !turnstileSiteKeyRaw ? undefined : turnstileSiteKeyRaw;

	return {
		hostedZoneId,
		hostedZoneName,
		appDomain,
		mtaStsDomain,
		imageRepository,
		dbName,
		multiAz: booleanContext(stack, "multiAz", false),
		vpcEndpoints: booleanContext(stack, "vpcEndpoints", false),
		turnstileSiteKey,
	};
}

/**
 * Custom-resource handler (plain JS, inlined so no bundling or Docker is
 * needed): reads the RDS-generated secret and writes the composed
 * postgresql:// URL (sslmode=require) into the mailflare/DatabaseUrl secret.
 * The password is never logged; failures surface in the CFN event reason.
 */
const COMPOSE_DATABASE_URL_HANDLER = `
const https = require("https");

function cfnRespond(event, status, reason) {
	return new Promise((resolve) => {
		const physicalResourceId = event.PhysicalResourceId || event.ResourceProperties.DatabaseUrlArn;
		const body = JSON.stringify({
			Status: status,
			Reason: reason,
			PhysicalResourceId: physicalResourceId,
			StackId: event.StackId,
			RequestId: event.RequestId,
			LogicalResourceId: event.LogicalResourceId,
			Data: {},
		});
		const target = new URL(event.ResponseURL);
		const request = https.request(
			{
				hostname: target.hostname,
				path: target.pathname + target.search,
				method: "PUT",
				headers: { "content-length": Buffer.byteLength(body) },
			},
			(response) => {
				response.resume();
				response.on("end", () => resolve());
			},
		);
		request.on("error", () => resolve());
		request.end(body);
	});
}

exports.handler = async (event) => {
	const props = event.ResourceProperties || {};
	try {
		if (event.RequestType === "Delete") {
			await cfnRespond(event, "SUCCESS", "nothing to clean up");
			return;
		}
		const { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } = require("@aws-sdk/client-secrets-manager");
		const client = new SecretsManagerClient({});
		const response = await client.send(new GetSecretValueCommand({ SecretId: props.RdsSecretArn }));
		if (!response.SecretString) throw new Error("RDS secret has no SecretString");
		const parts = JSON.parse(response.SecretString);
		const databaseUrl =
			"postgresql://" +
			encodeURIComponent(parts.username) +
			":" +
			encodeURIComponent(parts.password) +
			"@" +
			parts.host +
			":" +
			parts.port +
			"/" +
			props.DbName +
			"?sslmode=require";
		await client.send(new UpdateSecretCommand({ SecretId: props.DatabaseUrlArn, SecretString: databaseUrl }));
		await cfnRespond(event, "SUCCESS", "composed database url");
	} catch (error) {
		await cfnRespond(event, "FAILED", String((error && error.message) || error));
	}
};
`;

export class MailflareStack extends Stack {
	constructor(scope: Construct, id: string, props?: StackProps) {
		super(scope, id, props);

		const config = readConfig(this);

		if (!SES_RECEIVING_REGIONS.has(this.region)) {
			Annotations.of(this).addWarningV2(
				"@mailflare/stack/ses-receiving-region",
				`region ${this.region} does not support SES inbound receiving; mail ingestion needs one of: ${[...SES_RECEIVING_REGIONS].join(", ")}`,
			);
		}

		// ---------------------------------------------------------------------------
		// VPC: 2 AZs. NAT gateways by default; VPC endpoints when vpcEndpoints=true.
		// ---------------------------------------------------------------------------
		const vpc = new ec2.Vpc(this, "Vpc", {
			maxAzs: 2,
			natGateways: config.vpcEndpoints ? 0 : undefined,
		});
		const privateSubnetType = config.vpcEndpoints ? ec2.SubnetType.PRIVATE_ISOLATED : ec2.SubnetType.PRIVATE_WITH_EGRESS;

		if (config.vpcEndpoints) {
			const endpointSubnets = { subnetType: privateSubnetType };
			const interfaceServices: Array<[string, ec2.IInterfaceVpcEndpointService]> = [
				["SqsEndpoint", ec2.InterfaceVpcEndpointAwsService.SQS],
				["SnsEndpoint", ec2.InterfaceVpcEndpointAwsService.SNS],
				["SecretsManagerEndpoint", ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
				["StsEndpoint", ec2.InterfaceVpcEndpointAwsService.STS],
				["EcrApiEndpoint", ec2.InterfaceVpcEndpointAwsService.ECR],
				["EcrDkrEndpoint", ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
				["CloudWatchLogsEndpoint", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
			];
			for (const [endpointId, service] of interfaceServices) {
				new ec2.InterfaceVpcEndpoint(this, endpointId, { vpc, service, subnets: endpointSubnets });
			}
			vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });
			Annotations.of(this).addWarningV2(
				"@mailflare/stack/vpc-endpoints-limits",
				"vpcEndpoints=true disables NAT gateways; SES and Route 53 expose no VPC interface endpoints, so runtime calls to those services from isolated subnets will fail",
			);
		}

		// ---------------------------------------------------------------------------
		// Task role: everything the Mailflare container does at runtime.
		// ---------------------------------------------------------------------------
		const taskRole = new iam.Role(this, "TaskRole", {
			assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
		});

		const queueWithDlq = (id: string, queueName: string, maxReceiveCount: number): sqs.Queue => {
			const deadLetterQueue = new sqs.Queue(this, `${id}DeadLetterQueue`, {
				queueName: `${queueName}-dlq`,
				retentionPeriod: Duration.days(14),
				encryption: sqs.QueueEncryption.SQS_MANAGED,
			});
			return new sqs.Queue(this, id, {
				queueName,
				visibilityTimeout: Duration.seconds(300),
				retentionPeriod: Duration.days(14),
				encryption: sqs.QueueEncryption.SQS_MANAGED,
				deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount },
			});
		};
		const inboundQueue = queueWithDlq("InboundQueue", "mailflare-inbound", 13);
		const outboundQueue = queueWithDlq("OutboundQueue", "mailflare-outbound", 4);
		const agentQueue = queueWithDlq("AgentQueue", "mailflare-agent", 4);
		for (const queue of [inboundQueue, outboundQueue, agentQueue]) {
			queue.grantSendMessages(taskRole);
			queue.grantConsumeMessages(taskRole);
		}
		new CfnOutput(this, "InboundQueueUrl", { value: inboundQueue.queueUrl });
		new CfnOutput(this, "OutboundQueueUrl", { value: outboundQueue.queueUrl });
		new CfnOutput(this, "AgentQueueUrl", { value: agentQueue.queueUrl });

		// ---------------------------------------------------------------------------
		// S3 app bucket (attachments + backups).
		// ---------------------------------------------------------------------------
		const bucket = new s3.Bucket(this, "AppBucket", {
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			enforceSSL: true,
			encryption: s3.BucketEncryption.S3_MANAGED,
		});
		bucket.addLifecycleRule({ abortIncompleteMultipartUploadAfter: Duration.days(7) });
		bucket.grantReadWrite(taskRole);

		// SES (v2 send/identity + v1 receipt rules). Identities and receipt rules
		// are created at runtime, so these actions are not resource-scoped.
		taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: [
					"ses:SendEmail",
					"ses:SendRawEmail",
					"ses:GetAccount",
					"ses:PutAccountSendingAttributes",
					"ses:CreateEmailIdentity",
					"ses:GetEmailIdentity",
					"ses:ListEmailIdentities",
					"ses:DeleteEmailIdentity",
					"ses:PutEmailIdentityMailFromAttributes",
					"ses:PutEmailIdentityDkimAttributes",
					"ses:VerifyDomainIdentity",
					"ses:DeleteIdentity",
					"ses:ListIdentities",
					"ses:GetIdentityVerificationAttributes",
					"ses:GetIdentityDkimAttributes",
					"ses:SetIdentityDkimEnabled",
					"ses:SetIdentityFeedbackForwardingEnabled",
					"ses:SetIdentityNotificationTopic",
					"ses:PutIdentityPolicy",
					"ses:DeleteIdentityPolicy",
					"ses:GetIdentityPolicies",
					"ses:CreateReceiptRuleSet",
					"ses:CreateReceiptRule",
					"ses:UpdateReceiptRule",
					"ses:DeleteReceiptRule",
					"ses:DeleteReceiptRuleSet",
					"ses:DescribeReceiptRule",
					"ses:DescribeReceiptRuleSet",
					"ses:DescribeActiveReceiptRuleSet",
					"ses:SetActiveReceiptRuleSet",
				],
				resources: ["*"],
			}),
		);

		// SNS topics the SES inbound pipeline creates at runtime.
		taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: [
					"sns:CreateTopic",
					"sns:DeleteTopic",
					"sns:Subscribe",
					"sns:Unsubscribe",
					"sns:Publish",
					"sns:SetTopicAttributes",
					"sns:GetTopicAttributes",
					"sns:AddPermission",
				],
				resources: [`arn:${this.partition}:sns:${this.region}:${this.account}:mailflare-inbound*`],
			}),
		);
		taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({ actions: ["sns:ListTopics"], resources: ["*"] }),
		);

		// Raw inbound mail buckets created by the SES receipt rules at runtime.
		taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["s3:*"],
				resources: [
					`arn:${this.partition}:s3:::mailflare-inbound-*`,
					`arn:${this.partition}:s3:::mailflare-inbound-*/*`,
				],
			}),
		);

		// ---------------------------------------------------------------------------
		// Zone (imported by ID + name, no lookups) and certificate.
		// ---------------------------------------------------------------------------
		const zone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, "Zone", {
			hostedZoneId: config.hostedZoneId,
			zoneName: config.hostedZoneName,
		});

		taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["route53:ListHostedZones", "route53:ListHostedZonesByName", "route53:GetChange"],
				resources: ["*"],
			}),
		);
		taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ChangeResourceRecordSets"],
				resources: [zone.hostedZoneArn],
			}),
		);
		taskRole.addToPrincipalPolicy(
			new iam.PolicyStatement({ actions: ["sts:GetCallerIdentity"], resources: ["*"] }),
		);

		// ---------------------------------------------------------------------------
		// RDS PostgreSQL 16 on private subnets; password in a generated secret.
		// ---------------------------------------------------------------------------
		const database = new rds.DatabaseInstance(this, "Database", {
			engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
			instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.SMALL),
			vpc,
			vpcSubnets: { subnetType: privateSubnetType },
			multiAz: config.multiAz,
			storageEncrypted: true,
			databaseName: config.dbName,
			credentials: rds.Credentials.fromGeneratedSecret("mailflare"),
		});
		if (!database.secret) {
			throw new Error("expected RDS to generate a credentials secret");
		}
		const rdsSecret = database.secret;

		// ---------------------------------------------------------------------------
		// mailflare/DatabaseUrl: composed postgresql://...?sslmode=require URL,
		// written by a small custom resource so no operator step is required.
		// ---------------------------------------------------------------------------
		const databaseUrlSecret = new secretsmanager.Secret(this, "DatabaseUrlSecret", {
			secretName: "mailflare/DatabaseUrl",
			description: "Composed PostgreSQL connection URL (sslmode=require) for the Mailflare app",
		});
		new CfnOutput(this, "DatabaseUrlSecretArn", { value: databaseUrlSecret.secretArn });

		const composeDatabaseUrl = new lambda.Function(this, "ComposeDatabaseUrlFunction", {
			runtime: lambda.Runtime.NODEJS_LATEST,
			handler: "index.handler",
			code: lambda.Code.fromInline(COMPOSE_DATABASE_URL_HANDLER),
			timeout: Duration.minutes(1),
			description: "Composes the Mailflare DATABASE_URL from the RDS-generated secret",
		});
		rdsSecret.grantRead(composeDatabaseUrl);
		databaseUrlSecret.grantWrite(composeDatabaseUrl);

		const databaseUrlResource = new CustomResource(this, "DatabaseUrlResource", {
			serviceToken: composeDatabaseUrl.functionArn,
			resourceType: "Custom::MailflareDatabaseUrl",
			properties: {
				RdsSecretArn: rdsSecret.secretArn,
				DatabaseUrlArn: databaseUrlSecret.secretArn,
				DbName: config.dbName,
			},
		});

		// ---------------------------------------------------------------------------
		// ECS Fargate service.
		// ---------------------------------------------------------------------------
		const cluster = new ecs.Cluster(this, "Cluster", { vpc });
		const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
			cpu: 512,
			memoryLimitMiB: 1024,
			taskRole,
		});

		const environment: Record<string, string> = {
			NODE_ENV: "production",
			MAILFLARE_RUNTIME: "node",
			PORT: "3000",
			SMTP_INBOUND_PORT: "0",
			TRUST_PROXY: "1",
			APP_URL: `https://${config.appDomain}`,
			S3_BUCKET: bucket.bucketName,
			S3_REGION: this.region,
			DATA_DIR: "/tmp/mailflare-data",
			SQS_INBOUND_QUEUE_URL: inboundQueue.queueUrl,
			SQS_OUTBOUND_QUEUE_URL: outboundQueue.queueUrl,
			SQS_AGENT_QUEUE_URL: agentQueue.queueUrl,
		};
		if (config.turnstileSiteKey) environment.TURNSTILE_SITE_KEY = config.turnstileSiteKey;

		taskDefinition.addContainer("mailflare", {
			image: ecs.ContainerImage.fromRegistry(config.imageRepository),
			portMappings: [{ containerPort: 3000 }],
			environment,
			secrets: { DATABASE_URL: ecs.Secret.fromSecretsManager(databaseUrlSecret) },
			logging: ecs.LogDriver.awsLogs({ streamPrefix: "mailflare" }),
			healthCheck: {
				command: [
					"CMD-SHELL",
					"node -e \"fetch('http://127.0.0.1:3000/api/setup/status').then((r) => { if (r.status >= 300) process.exit(1); }).catch(() => process.exit(1))\"",
				],
				interval: Duration.seconds(30),
				timeout: Duration.seconds(5),
				retries: 3,
				startPeriod: Duration.seconds(30),
			},
		});

		const service = new ecs.FargateService(this, "Service", {
			cluster,
			taskDefinition,
			desiredCount: 1,
			assignPublicIp: false,
			vpcSubnets: { subnetType: privateSubnetType },
			healthCheckGracePeriod: Duration.seconds(60),
			circuitBreaker: { enable: true, rollback: true },
			minHealthyPercent: 0,
			maxHealthyPercent: 100,
		});
		// The composed DATABASE_URL must exist before the first task starts.
		service.node.addDependency(databaseUrlResource);

		// ---------------------------------------------------------------------------
		// ALB + certificate + Route 53 aliases.
		// ---------------------------------------------------------------------------
		const certificate = new acm.Certificate(this, "Certificate", {
			domainName: config.appDomain,
			subjectAlternativeNames: config.mtaStsDomain ? [config.mtaStsDomain] : [],
			validation: acm.CertificateValidation.fromDns(zone),
		});

		const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
			vpc,
			internetFacing: true,
			idleTimeout: Duration.seconds(3600),
		});

		const httpsListener = loadBalancer.addListener("HttpsListener", {
			port: 443,
			certificates: [certificate],
			open: true,
		});
		httpsListener.addTargets("AppTarget", {
			port: 3000,
			protocol: elbv2.ApplicationProtocol.HTTP,
			targets: [service],
			deregistrationDelay: Duration.seconds(30),
			healthCheck: {
				path: "/api/setup/status",
				healthyHttpCodes: "200-299",
				interval: Duration.seconds(30),
				timeout: Duration.seconds(5),
				healthyThresholdCount: 2,
				unhealthyThresholdCount: 3,
			},
		});

		const httpListener = loadBalancer.addListener("HttpListener", {
			port: 80,
			open: true,
			defaultAction: elbv2.ListenerAction.redirect({ protocol: "HTTPS", port: "443", permanent: true }),
		});

		const aliasTarget = route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(loadBalancer));
		new route53.ARecord(this, "AppAliasA", { zone, recordName: config.appDomain, target: aliasTarget });
		new route53.AaaaRecord(this, "AppAliasAAAA", { zone, recordName: config.appDomain, target: aliasTarget });
		if (config.mtaStsDomain) {
			new route53.ARecord(this, "MtaStsAliasA", { zone, recordName: config.mtaStsDomain, target: aliasTarget });
			new route53.AaaaRecord(this, "MtaStsAliasAAAA", { zone, recordName: config.mtaStsDomain, target: aliasTarget });
		}
	}
}

const app = new App();
const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const account = process.env.CDK_DEFAULT_ACCOUNT ?? "123456789012";

// Seed the availability-zone context so `ec2.Vpc` synthesizes without AWS
// calls (spec: no lookups). AZ names follow `<region>a|b|c` in every
// commercial region; clear cdk.context.json or this context to override.
const availabilityZoneContextKey = `availability-zones:account=${account}:region=${region}`;
if (app.node.tryGetContext(availabilityZoneContextKey) === undefined) {
	app.node.setContext(availabilityZoneContextKey, [`${region}a`, `${region}b`, `${region}c`]);
}

new MailflareStack(app, "MailflareStack", { env: { region, account } });
app.synth();
