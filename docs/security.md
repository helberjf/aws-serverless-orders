# Security review and permission boundaries

## Application boundary

API Gateway's Cognito authorizer validates the JWT signature for the configured pool. The Lambda code trusts the authorizer context, then validates `token_use=access`, issuer, configured client ID, expiry, subject and route scope. This is defense in depth, not a standalone JWT verifier for arbitrary direct Lambda invocation. Only trusted operators should receive `lambda:InvokeFunction`; clients must use API Gateway. Forged claim fixtures in unit tests cannot authenticate a real API request.

GET uses a consistent read and returns the same 404 for absent orders and another user's orders. The caller cannot set `ownerId`; `customerId` is a validated business label. Legacy records are hidden until ownership has been explicitly migrated. Input limits, generic internal errors, TLS-only resource policies and a per-method API throttle of ten requests/second with a twenty-request burst reduce avoidable exposure. API throttling is best effort, not a spending cap or DDoS product.

Cognito uses the Lite tier, code flow, a public client with no secret, fifteen-minute access tokens and optional software-token MFA. Self-registration and email/SMS recovery flows are disabled. Mandatory MFA, frontend origin rules, custom domain and WAF are future environment-specific choices. No real email/phone recipient is committed.

## Runtime roles

| Function        | Application permissions                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| CreateOrder     | Read idempotency; conditional puts to orders/idempotency/outbox                                                 |
| GetOrder        | Read the orders table                                                                                           |
| Health          | No application data/service access                                                                              |
| ProcessOrder    | Poll its order queue; read/update orders; put fulfillment/outbox                                                |
| NotifyOrder     | Poll its notification queue; read/write receipt; put outbox                                                     |
| PublishOrder    | Read outbox stream/rows; lease/update outbox; publish to exact queue, bus and topic; stream failure destination |
| ReconcileOutbox | Query the one recovery index; read/update outbox; publish to the same exact destinations                        |

All seven roles have only their own log group's write access. Transactions authorize the underlying item actions on the exact tables; a broad `dynamodb:*` permission is not used. The CodeDeploy role controls only the three exact live aliases and reads this stack's alarms. EventBridge and SNS resource policies restrict the sending resource ARN/account.

The reconciler's `Query` grant includes the outbox table and its one recovery index, as required by [DynamoDB resource authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_dynamodb.html). CloudFormation's SNS subscription lifecycle actions use the parent topic ARN, not a subscription ARN; this follows the [SNS authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sns.html). Both grants remain restricted to this application's resources.

## Deliberate IAM wildcard exceptions

These exceptions are explicit and checked where applicable; wildcard suffixes in a resource ARN do not grant every AWS service action.

- Runtime `xray:PutTraceSegments` and `xray:PutTelemetryRecords` use `Resource: "*"` because X-Ray write APIs do not support resource-level ARNs. No read/admin X-Ray action is granted. [AWS authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_xray.html).
- SNS publishers' KMS access uses account/region key ARNs with `kms:ViaService` restricted to SNS and `kms:ResourceAliases` restricted to `alias/aws/sns`. The AWS-managed key's ID is not known when authoring the template.
- `Resource: "*"` inside the optional alarm **key policy** refers to that key. Its account-root `kms:*` statement enables account IAM administration of the key and avoids a lockout; it is not attached to a Lambda role. The CloudWatch use statement is source-account/alarm-prefix restricted. [KMS key policies](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html).
- `Principal: "*"` and action wildcards in explicit **Deny** policies enforce TLS for all callers. They grant no access.
- CloudFormation bootstrap `lambda:CreateEventSourceMapping` cannot target a pre-existing mapping ARN; it uses `*` with `lambda:FunctionArn` restricted to this application's functions and a region condition. Generated mapping UUID resources are subsequently limited to the account/region. [Lambda authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_lambda.html).
- CloudFormation `logs:DescribeLogGroups`, `cognito-idp:CreateUserPool`, `cognito-idp:DescribeUserPoolDomain`, `codedeploy:CreateCloudFormationDeployment` and `codedeploy:StopDeployment` have no usable resource-level scope for these operations. They are enumerated and region restricted. User-pool UUIDs and API Gateway-generated REST API IDs cannot be constrained by the application name; their lifecycle access is account/region limited.
- Optional KMS key creation/tagging uses `*` with the required application `Project` request tag; later key management uses that resource tag. IAM permits creation only of the exact API Gateway service-linked role and only for `ops.apigateway.amazonaws.com`.

The CloudFormation execution role is privileged infrastructure administration. It can create/update inline policies on application-prefixed roles and manage regional API resources; it is **not an anti-escalation boundary for malicious templates**. Its own role and the OIDC roles live under `/aws-orders-ci/`, outside the application's role prefix. Trusted code review, protected environments and preferably separate AWS accounts are required. The PR CI job has no OIDC permission. Plan can upload artifacts and create a Change Set but cannot execute it; apply executes the reviewed set without changing its template.

## Secrets, encryption and logging

No external provider requires an application secret today. Resource names/ARNs are environment configuration. IAM roles provide short-lived AWS credentials. New payment/API credentials would require a specifically scoped Secrets Manager secret or SSM SecureString and retrieval at runtime; never commit them or expose them through Change Set parameters/artifacts.

DynamoDB uses service encryption, SQS uses managed SSE, SNS uses `alias/aws/sns`, and the artifact bucket uses SSE-S3, public-access blocking, versioning and TLS enforcement. A separate customer-managed key protects optional CloudWatch alarm notifications because their service integration needs a controlled key policy. No database encryption key is needlessly provisioned for every table.

Logs contain identifiers and error class names, not payloads, authorization headers, passwords, stacks or raw AWS error messages. X-Ray response/error payload capture is disabled. The login helper stores only a short-lived access token in an ignored local file; Windows users should keep it within their private user profile/ACL. Never upload `.tokens/` as an artifact.

## Verification limits

Local checks verify role separation, explicit wildcard exceptions, signatures/scopes as authorizer-context contracts, no embedded recognized credential patterns and zero known npm audit findings at the recorded date. The scanner is intentionally small and cannot guarantee the absence of every possible secret. Cloud IAM policy evaluation, SCPs, trust policies and service integration still need a real development deployment and account-specific review. No penetration test, formal threat model, compliance certification or production authorization is claimed.
