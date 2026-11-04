# Portfolio presentation

## Suggested GitHub description

Event-driven order processing with TypeScript, AWS SAM, transactional outbox, DynamoDB, SQS, Cognito, EventBridge/SNS, and monitored canary deployments.

## Suggested topics

`aws`, `serverless`, `typescript`, `nodejs`, `aws-lambda`, `aws-sam`, `cloudformation`, `dynamodb`, `sqs`, `eventbridge`, `sns`, `cognito`, `transactional-outbox`, `idempotency`, `event-driven`, `observability`, `github-actions`, `oidc`, `ci-cd`, `aws-developer-associate`

This text is prepared for repository settings after review; it is not evidence that a live environment has been deployed.

## Engineering walkthrough

1. Explain why writing an order and sending SQS separately can lose work, then show the creation transaction and durable outbox.
2. Demonstrate same-key HTTP replay, payload conflict and ownership isolation with the automated tests.
3. Show the conditional fulfillment transaction, a partially failing batch and concurrent duplicate delivery against DynamoDB Local.
4. Trace `OrderProcessed` through the bus, notification receipt and SNS outbox; explain the remaining duplicate-delivery window honestly.
5. Inspect the expanded SAM alias integration, alarms and CodeDeploy rollback configuration.
6. Walk through separate OIDC plan/apply roles, the Change Set artifact and the production approval gate.
7. Present the actual validation record. Add live reports and rollback evidence only after approved AWS execution.

## DVA-C02-relevant practical skills

| Area                             | Evidence in this repository                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| AWS application development      | Typed SDK v3 handlers, validation, REST contracts, conditional transactions, business events   |
| Security                         | Cognito scopes/ownership, dedicated IAM roles, encryption and scoped resource policies         |
| Deployment                       | SAM/esbuild, immutable versions/aliases, OIDC, Change Sets, canary/rollback configuration      |
| Troubleshooting and optimization | Structured correlation, X-Ray, alarms, partial failures, recovery runbooks and cost trade-offs |

This is a practical project, not an official exam syllabus, AWS endorsement, compliance certification or a claim of production traffic. Step Functions is discussed as a deliberate exclusion instead of being added without a business need.
