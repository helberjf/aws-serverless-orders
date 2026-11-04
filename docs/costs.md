# Cost model and lab limits

**Planning estimate, checked 2026-11-04:** reserve approximately **US$10–15 per month for one continuously deployed, lightly used environment in `sa-east-1`**, before tax. This is an engineering budget estimate, not a quote, billing measurement or spending cap. A second environment roughly doubles the fixed monitoring footprint. No AWS resources were deployed during this implementation.

## Assumptions

- One region and one application stack for a full month.
- Around 1,000 small orders, at most 10,000 HTTP requests, two test users and modest retries.
- 256 MiB on-demand Lambda functions, small payloads, no provisioned concurrency or load testing.
- Roughly 0.1 GiB of logs and less than 1 GiB of retained database/artifact data.
- No optional email recipient, customer-managed alarm key, external payment provider, shared public dashboard or SMS.
- No credits or free allowances deducted: they may already be consumed elsewhere in the account.

## Monitoring baseline

The CloudWatch São Paulo price feed (publication `2026-10-07T11:55:40Z`) lists standard alarm metrics at **US$0.135 per metric-month**, the first custom metric tier at **US$0.30 per metric-month**, and Standard log ingestion at **US$0.90 per GB**. [AWS regional price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/sa-east-1/index.json).

| Component                | Conservative full-month calculation                                                       | Approximate USD |
| ------------------------ | ----------------------------------------------------------------------------------------- | --------------: |
| 26 alarms                | 25 single-metric alarms + two input metrics for the API math alarm = 27 × 0.135           |            3.65 |
| Five application metrics | Invocations, UnhandledErrors, OperationFailures, HttpRequests, HttpServerErrors; 5 × 0.30 |            1.50 |
| One custom dashboard     | Budgeted at 3/month before eligible account allowances                                    |            3.00 |
| 0.1 GB log ingestion     | 0.1 × 0.90; storage and queries extra                                                     |            0.09 |
| Monitoring subtotal      | Rounded; metrics may be prorated when emitted for fewer hours                             |        **8.24** |

Dashboard charges and free allowances depend on account usage. Sharing dashboards or running log queries can add costs. See [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) and [AWS's dashboard cost explanation](https://repost.aws/de/articles/ARJhe7eJ4UQeC6vrhX33TtiQ/understanding-cloudwatch-costs-why-your-bill-jumped-what-s-driving-it-and-how-to-cut-it). The estimate does not subtract free metrics, alarms or dashboards.

Allow another approximately US$1–5 for small-volume compute, requests, queue polling, storage/PITR, traces and artifacts under these assumptions. This allowance is a planning margin, not a separately metered service price. Validate the workload in the [AWS Pricing Calculator](https://calculator.aws/) before approving deployment or load tests. The default region is São Paulo; do not apply US East prices silently.

## Variable charges

- **Lambda:** request count and memory-duration. Seven functions do not imply seven always-running servers; retries and cold starts affect duration. [Lambda pricing](https://aws.amazon.com/lambda/pricing/).
- **DynamoDB:** on-demand read/write units, transactional overhead, GSI writes/storage, retained data and point-in-time recovery. The outbox requires multiple item operations per order. [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/).
- **SQS:** sends, receives, deletes and visibility updates. Empty long polls can be billed even with no orders; both Lambda event source mappings keep polling. Payload size, retries and redrive multiply requests. [SQS pricing](https://aws.amazon.com/sqs/pricing/).
- **Recovery:** the five-minute schedule produces about 8,640 reconciler invocations in thirty days, including idle periods. Queries are bounded and indexed; large recovery backlogs take longer by design.
- **API Gateway/EventBridge/SNS:** request/event/delivery volume and payload size. Default fan-out includes one audit queue. Additional subscriptions change delivery costs. [API Gateway](https://aws.amazon.com/api-gateway/pricing/), [EventBridge](https://aws.amazon.com/eventbridge/pricing/), [SNS](https://aws.amazon.com/sns/pricing/).
- **Cognito:** Lite with human sign-in, not machine-to-machine client credentials. Eligible direct-user allowances are shared at account/organization scope; additional features or user volume change billing. [Cognito pricing](https://aws.amazon.com/cognito/pricing/).
- **S3/X-Ray/logs:** artifact requests/storage, sampled traces, log searches and unusually verbose failures. Versioned artifacts persist until reviewed cleanup or lifecycle expiration.

## Optional alarm notification cost

Setting `AlarmEmail` provisions an encrypted SNS topic and a customer-managed KMS key. Budget **US$1/month for the initial key**, plus applicable requests and SNS deliveries. The first and second key rotations can add storage charges; rotation is enabled. AWS-managed SNS encryption has request charges but no separately created customer-managed key in the default configuration. [KMS pricing](https://aws.amazon.com/kms/pricing/).

Leaving `AlarmEmail` empty avoids that key but does not disable alarms or canary rollback. `TestNotificationEmail` adds an approved subscription to the existing application topic. No real recipient is committed.

## Free Tier and controls

Eligibility depends on account creation date, plan, service, region and shared usage. New-account credits and time-limited plans do not guarantee that the lab stays free. Restricted plans can prevent access to required services. Check the account's Billing/Free Tier pages and [current AWS Free Tier FAQ](https://aws.amazon.com/free/free-tier-faqs/).

The stack avoids NAT Gateway, ECS, RDS, ALB, provisioned concurrency, custom KMS keys per table and high-cardinality metric dimensions. Detailed API method metrics are off. Logs expire after fourteen days, completed outbox entries after seven days, and idempotency responses after twenty-four hours. Durable business records and notification receipts intentionally remain.

Throttling and bounded batches are not a billing cap. Inspect actual spending after the first day and after retry incidents. Obtain approval before adding subscriptions, deploying production, load testing or maintaining multiple stacks.

## Cleanup

`sam delete` can destroy queues/logs but retains the configured tables/user pool. Bootstrap artifacts/provider are retained too. Storage/PITR may continue to be billed. Follow the [cleanup procedure](operations.md#cleanup); no destructive AWS cleanup was performed in this task.
