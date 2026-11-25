# Mailflare on AWS (ECS Fargate via CDK)

`deploy/aws/app.ts` is a single CDK v2 stack that provisions a VPC (2 AZs),
RDS PostgreSQL 16 on private subnets, an S3 app bucket, three SQS queues with
dead-letter queues, an internet-facing ALB with an ACM certificate and Route 53
aliases, and one ECS Fargate task running the Mailflare image.

Synth-only check (no AWS credentials or lookups needed): `npm --prefix deploy/aws run synth`.

## Prerequisites

- An AWS account with credentials configured for the AWS CLI
  (`aws sts get-caller-identity` succeeds). CDK reads the account/region from
  your CLI environment.
- A **Route 53 public hosted zone** for your domain, with its name servers
  delegated at your registrar. `appDomain` must be inside that zone.
- A region that supports SES inbound receiving (the stack warns at synth time
  if it does not). These match `SES_RECEIVING_REGIONS` in `deploy/aws/app.ts`:
  `us-east-1`, `us-east-2`, `us-west-2`, `ca-central-1`, `sa-east-1`,
  `eu-central-1`, `eu-west-1`, `eu-west-2`, `eu-west-3`, `eu-north-1`,
  `il-central-1`, `ap-south-1`, `ap-southeast-1`, `ap-southeast-2`.
- Node + npm, and Docker for the image build.

## 1. Build and push the image

The stack runs whatever image you pass as `-c imageRepository=<image>`; it does
not build one. Build the self-hosted image from the **repo root** and push it
to ECR:

```sh
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export AWS_DEFAULT_REGION=us-east-1
export IMAGE_TAG=$(git rev-parse --short HEAD)
export IMAGE_URI=${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com/mailflare:${IMAGE_TAG}
aws ecr create-repository --repository-name mailflare || true
aws ecr get-login-password | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com
docker build -t ${IMAGE_URI} .
docker push ${IMAGE_URI}
```

Optional: embed the client-side Turnstile key at build time with
`--build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY=...`; the server-side value is set
at deploy time via `-c turnstileSiteKey=...`.

The image also bundles the AWS RDS TLS trust store: the Dockerfile fetches
`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` at build
time, installs it at `/etc/ssl/certs/rds-global-bundle.pem` and sets
`NODE_EXTRA_CA_CERTS` to it, so `DATABASE_URL=...?sslmode=require` verifies
against RDS out of the box.

## 2. Bootstrap CDK (once per account/region)

```sh
cd deploy/aws
npm install
cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_DEFAULT_REGION}
```

## 3. Deploy

> **`hostedZoneId` must be passed on a real deploy.** `cdk.json` does not set
> it, and `app.ts` falls back to the synth-only placeholder
> `Z0123456789ABCDEFGHIJ` so `cdk synth` passes without AWS. With the
> placeholder the Route 53 records target a nonexistent zone and the deploy
> fails; setting it empty (`-c hostedZoneId=`) throws by design. Always pass
> `-c hostedZoneId=<your-real-zone-id>`.

```sh
cd deploy/aws
cdk deploy \
	-c hostedZoneId=<your-real-zone-id> \
	-c appDomain=mail.example.com \
	-c imageRepository=${IMAGE_URI}
```

Context flags (also settable in `deploy/aws/cdk.json`):

| Context | Default | Notes |
| --- | --- | --- |
| `hostedZoneId` | placeholder | **Required at deploy.** Route 53 hosted zone ID. |
| `appDomain` | `mail.example.com` | App hostname; must be inside the zone. |
| `hostedZoneName` | derived | Zone name, derived from `appDomain` minus its first label; set it explicitly when `appDomain` has fewer than 3 labels or the zone name differs. |
| `mtaStsDomain` | none | Optional extra certificate SAN + alias, e.g. `mta-sts.example.com`; must be inside the zone. |
| `imageRepository` | placeholder | Container image pushed in step 1; **required at deploy.** |
| `dbName` | `mailflare` | RDS database name. |
| `multiAz` | `false` | RDS Multi-AZ. |
| `vpcEndpoints` | `false` | VPC interface/gateway endpoints instead of NAT gateways. |
| `turnstileSiteKey` | none | Optional `TURNSTILE_SITE_KEY` env value. |

Deploy outputs: `InboundQueueUrl`, `OutboundQueueUrl`, `AgentQueueUrl`,
`DatabaseUrlSecretArn`.

## 4. Post-deploy setup

1. Open `https://<appDomain>/setup` and complete the in-app setup, choosing
   SES for sending and receiving mail.
2. MX, SPF and DKIM records are written by the app through its Route 53 DNS
   seam (`src/lib/aws/route53`) as part of domain provisioning in-app; the
   stack itself only creates the ALB and optional MTA-STS aliases.
3. SES receiving requires a public HTTPS `APP_URL` (SNS calls back into the
   app); the stack sets `APP_URL=https://<appDomain>`.

## Limitations

- **Single task.** The service runs with `desiredCount=1`: the realtime
  WebSocket hub, cron and the SQS consumers all run in-process in that one
  task. Scaling out (`desiredCount > 1`) needs a pub/sub bridge for realtime
  fan-out (and cron leadership) before it is safe.
- **SES sandbox.** New SES accounts can only send to verified recipients;
  request production access before sending real outbound mail.
- **No direct SMTP inbound.** The stack sets `SMTP_INBOUND_PORT=0`; inbound
  mail arrives via SES receipt rules instead of the built-in SMTP listener.
- **SES receiving regions are gated twice.** `cdk synth` warns via a region
  list in `deploy/aws/app.ts`, while in-app setup enforces its own
  `SES_RECEIVING_REGIONS` in `src/lib/aws/config.ts`; the two lists currently
  differ (for example `eu-west-3`, `eu-north-1` and `il-central-1` are allowed
  by `app.ts` but not by `config.ts`, while `ap-northeast-1` and
  `us-gov-west-1` are the reverse), so a region that passes synth can still be
  rejected by in-app setup. Reconciling the lists is a code follow-up.

## Environment and secrets reference

Set by the stack on the Fargate task:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `MAILFLARE_RUNTIME` | `node` |
| `PORT` | `3000` |
| `SMTP_INBOUND_PORT` | `0` |
| `TRUST_PROXY` | `1` (behind the ALB) |
| `APP_URL` | `https://<appDomain>` |
| `S3_BUCKET` / `S3_REGION` | stack bucket / deploy region (object storage via the S3 seam) |
| `DATA_DIR` | `/tmp/mailflare-data` (ephemeral task storage; durable data lives in RDS/S3) |
| `SQS_INBOUND_QUEUE_URL` / `SQS_OUTBOUND_QUEUE_URL` | stack queues (durable SQS instead of in-process queues) |
| `SQS_AGENT_QUEUE_URL` | stack agent queue — **currently inert**: the runtime reads `AGENT_QUEUE_URL` for the agent queue (`server/runtime/env.ts`), so until the names are reconciled the agent queue still runs in-process |
| `AWS_SESSION_TOKEN` / `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` | set automatically by ECS for the task role; consumed by the task-role credential chain in `src/lib/aws/config.ts` (saved settings → env → task role) |
| `TURNSTILE_SITE_KEY` | set only when `-c turnstileSiteKey=` was passed |

Injected secrets: `DATABASE_URL` comes from the Secrets Manager secret
`mailflare/DatabaseUrl` (ARN in the `DatabaseUrlSecretArn` output). The
`ComposeDatabaseUrl` custom resource composes the `postgresql://` URL
(`sslmode=require`) from the RDS-generated credential secret at deploy time,
before the first task starts.
