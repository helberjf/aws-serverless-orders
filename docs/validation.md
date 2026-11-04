# Validation evidence

Recorded on **2026-11-04**. Results below were actually executed in the local workspace. Infrastructure configuration is distinguished from managed AWS behavior; no cloud test result is inferred from a unit test or template validation.

## Executed checks

| Check                                                        | Observed result                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `npm ci`                                                     | Clean installation completed                                                                 |
| `npm run typecheck`                                          | Passed, TypeScript strict                                                                    |
| `npm run lint`                                               | Passed                                                                                       |
| `npm run format:check`                                       | Passed after formatting                                                                      |
| `npm run test:unit`                                          | **101 tests passed** in eight files                                                          |
| V8 coverage                                                  | **100% lines, 99.21% statements, 100% functions, 93.75% branches**                           |
| `npm run test:integration`                                   | **Six tests passed** against real DynamoDB Local                                             |
| `python -m unittest discover -s tests/infra -v`              | **Eleven tests passed**, including real offline SAM transformation                           |
| `python -m unittest discover -s tests/tooling -v`            | **Fifteen tests passed**, including plan/apply, production gates and safe queue inspection   |
| `npm audit --audit-level=moderate`                           | **Zero known vulnerabilities** across production and development dependencies                |
| `python scripts/check-secrets.py`                            | Passed the documented credential-pattern check                                               |
| Python compilation and Black checks                          | Passed for operator tools and infrastructure/tooling tests                                   |
| `sam validate --lint`                                        | Application template valid                                                                   |
| `cfn-lint infra/github-oidc.yaml`                            | Bootstrap template valid                                                                     |
| `sam build`                                                  | **Seven function bundles built successfully**                                                |
| `node scripts/check-build.cjs`                               | All seven handlers loaded; built health handler returned 200                                 |
| `sam local invoke HealthFunction --event events/health.json` | **HTTP 200** in the Docker Node.js 24 Lambda runtime, with JSON liveness body and request ID |
| Actionlint 1.7.12                                            | Both GitHub workflows validated locally                                                      |
| Mermaid 12.3.0 parser                                        | README architecture diagram parsed successfully as `flowchart-v2`                            |

Total: **133 automated test cases** across unit, local integration, infrastructure and tooling suites. Subtests inside Python cases are not added to that total. These figures are measured evidence, not targets or estimates.

The local SAM invocation emitted a runtime timezone fallback warning and a runtime shutdown message after returning its successful response; the command exited zero. This demonstrates the containerized health handler only, not a deployed API Gateway route.

## Tools used

Node.js 24.19.0; npm 11.17; Vitest 5.1.0; AWS SAM CLI 1.171.0; SAM translator 1.115.0; cfn-lint 1.58.0; Python 3.12 tooling; DynamoDB Local 3.3.2; Black 26.10.1. npm versions are resolved in `package-lock.json`, Python tooling in `requirements-dev.txt`. Actionlint was downloaded from its official v1.7.12 release and checked against the release SHA-256 checksum file. Diagram validation dependencies were temporary authoring tools and were not added to application dependencies.

## What the integration suite actually proves

The suite creates isolated DynamoDB Local tables, executes the real create/get/process/notification handlers and inspects committed state. It verifies:

- creation through publication/processing/notification intent, with transport test doubles;
- concurrent creation with one owner/idempotency key;
- owner isolation and conflicting request payloads;
- concurrent duplicate processing with one fulfillment/business event;
- no partial business commit when the fulfillment transaction fails;
- mixed batch failures and unchanged successful timestamps on replay.

SQS, EventBridge and SNS calls are mocked in this local integration suite. DynamoDB Streams triggers, Lambda event source polling, managed DLQ redrive, real SNS delivery, JWT signature verification and AWS IAM permissions are not exercised by it. The unit suite also checks individual publication rejection, ambiguous acknowledgments, leases/backoff, malformed messages, unavailable orders, replay and scope/token constraints.

## Cloud and GitHub execution status

No AWS profile or credentials were available in this workspace. No development/production stack, Cognito pool, queue, subscription, OIDC role or KMS key was created. No email was sent and no AWS cleanup was performed.

The [PR #4 CI run](https://github.com/helberjf/aws-serverless-orders/actions/runs/41777765747), for revision `20f1ab3`, was rejected before any steps started with: **“The job was not started because your account is locked due to a billing issue.”** This confirms the account restriction also affects the new workflow. The workflow source passes local Actionlint and the CI-equivalent checks above, but that does not establish a successful hosted runner execution. Billing/account resolution requires the account owner. No bypass or billing change was attempted. The separate GitGuardian check passed for that revision; CodeRabbit skipped its review of the draft PR.

No GitHub environments were present when inspected. The bootstrap template and production preflight are prepared, but OIDC trust, production reviewers and live deployment remain unconfigured until the documented setup is authorized and executed.

## Remaining evidence checklist

| Acceptance item         | Local evidence                                                 | Required live evidence                                                  |
| ----------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| API create/get/health   | Handler tests; container health invocation                     | Deployed API and real Cognito token                                     |
| Persistence/idempotency | DynamoDB Local transactions and concurrency tests              | Live E2E report                                                         |
| SQS batches/retries/DLQ | Partial failure tests; expanded mapping/redrive settings       | `smoke-test.py --exercise-dlq` report                                   |
| EventBridge/SNS         | Dispatcher/consumer tests and configured routing               | Correlated audit-queue notification                                     |
| IAM/security            | Scoped roles, authorizer/scope checks and policy tests         | Target-account deployment and negative access checks                    |
| Observability           | Logs/metrics instrumentation and alarm definitions             | Dashboard metrics, logs, sampled traces and alarm transitions           |
| Canary/rollback         | Generated alias integration and CodeDeploy configuration tests | Second deployment, observed weights, induced failure, recorded rollback |
| GitHub CI/CD            | Actionlint and local CI-equivalent checks                      | Hosted passing CI, OIDC plan, review approval and apply                 |

Use the exact commands in [deployment and live verification](deployment.md), preserve `.deploy/live-report.json`, `.deploy/live-with-dlq.json`, probe observations and deployment IDs, then update this record with the account/region/revision and actual results. Remove tokens and private customer data before attaching evidence to a PR. Do not mark the cloud rows complete without executing them.
