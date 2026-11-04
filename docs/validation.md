# Validation evidence

This document separates executed local checks from checks that need a deployed AWS environment. It does not certify a production rollout.

## Core milestone — 2026-11-04

- `npm ci` executed on Node.js 24.
- TypeScript, ESLint and Prettier checks passed.
- 78 unit tests passed with Vitest: 100% line coverage and 92.13% branch coverage at this milestone.
- Six integration tests passed against the actual DynamoDB Local 3.3.2 engine in Docker. They exercised atomic writes, concurrent creation and processing, ownership, duplicate delivery, and partial failures. SQS and EventBridge transports were test doubles; these are not AWS end-to-end results.
- `sam validate --lint` and `sam build` passed for the expanded core infrastructure.
- No AWS profile or credentials were available. No cloud resources were created, no production deployment was attempted, and no rollback was demonstrated.

The final validation results and live-environment commands are updated as the remaining phases are completed.
