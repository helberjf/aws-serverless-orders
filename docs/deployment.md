# Deployment and live verification

These procedures are prepared for an **authorized development deployment**. No AWS deployment was executed during the local implementation. Review [costs](costs.md), the target account/region, IAM permissions and the Change Set before creating resources. Production needs separate owner approval and the GitHub environment gate described below.

## Prerequisites

Use a dedicated learning account when possible. Install AWS CLI v2, Node.js 24, Docker and Python 3.12, then follow the README's local setup. Authenticate a human operator through IAM Identity Center/SSO or another temporary-credential mechanism. Do not put AWS access keys in the repository or GitHub Secrets.

```bash
aws sts get-caller-identity
aws configure get region
npm ci
npm run check
sam validate --lint --region sa-east-1
sam build
```

Check available Lambda concurrency, API Gateway, Cognito and IAM quotas. The two SQS mappings cap concurrency at five each; HTTP functions and outbox workers need additional account capacity. An organizational SCP, permissions boundary, disabled service, or restricted Free Tier plan can block deployment even if this template validates locally.

## Provision the OIDC bootstrap

`infra/github-oidc.yaml` defines the artifact bucket, GitHub provider, plan role, apply role and CloudFormation execution role. A trusted bootstrap operator needs permission to create these resources. No application resources require manual console creation.

First check whether this account already has `token.actions.githubusercontent.com` in IAM OIDC providers. Reuse that provider with `ExistingGitHubProviderArn`; an account cannot create a second provider for the same URL. The first bootstrap creates it if the parameter is empty. The provider and versioned artifact bucket are retained on deletion.

After cost and IAM approval, create a reviewable bootstrap Change Set:

```bash
aws cloudformation deploy \
  --template-file infra/github-oidc.yaml \
  --stack-name orders-ci-development \
  --region sa-east-1 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides GitHubRepository=helberjf/aws-serverless-orders ApplicationStackName=orders-development EnvironmentName=development \
  --no-execute-changeset
```

For an existing provider, append `ExistingGitHubProviderArn=<provider-arn>` to the parameter overrides. Inspect the Change Set shown by the CLI using `aws cloudformation describe-change-set --change-set-name <change-set-arn> --region sa-east-1`. Only after approval, execute that exact ARN with `aws cloudformation execute-change-set --change-set-name <change-set-arn> --region sa-east-1` and wait for the stack to complete.

Retrieve the outputs:

```bash
aws cloudformation describe-stacks --stack-name orders-ci-development --region sa-east-1 --query 'Stacks[0].Outputs'
```

For production, use a separate bootstrap/application stack and preferably a separate account. Set `EnvironmentName=production`, choose a distinct application stack name such as `orders-production`, and reuse the provider only when using the same account. Creating production infrastructure is not part of an unapproved demonstration.

The role trust is deliberately exact:

```json
{
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:helberjf/aws-serverless-orders:environment:development-plan"
  }
}
```

The apply role uses `environment:development`; production uses `production-plan` and `production`. Do not replace these values with a repository-wide wildcard. When OIDC uses an environment subject, branch restrictions belong to the GitHub environment. See [GitHub's AWS OIDC guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

## Configure GitHub environments

Create four environments in repository settings: `development-plan`, `development`, `production-plan`, and `production`. The workflow does not silently create trustworthy protection rules for you. None were configured in the account during this implementation.

| Environment        | Required controls                                                                          | Variables                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `development-plan` | Allow only trusted development/review branches                                             | `AWS_REGION`, `STACK_NAME`, `ARTIFACT_BUCKET`, `CLOUDFORMATION_EXECUTION_ROLE_ARN`, `AWS_PLAN_ROLE_ARN` |
| `development`      | Same trusted branches; optional reviewer for the lab                                       | `AWS_REGION`, `STACK_NAME`, `AWS_DEPLOY_ROLE_ARN`                                                       |
| `production-plan`  | Custom deployment branch rule **only `main`**, type Branch                                 | Same plan variables, using production bootstrap outputs                                                 |
| `production`       | Custom rule **only `main`**, at least one required reviewer, administrator bypass disabled | Same apply variables, using production outputs                                                          |

Use matching `STACK_NAME` and `AWS_REGION` values in each plan/apply pair. Role ARNs and the bucket name come from bootstrap outputs. These identifiers are configuration variables, not AWS secrets. No `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secret is needed.

The planner rejects an existing stack whose `EnvironmentName` differs from the requested environment, before uploading a template or creating a Change Set. A development/production mismatch must be resolved by selecting the correct stack and credentials; the tool never converts one environment into the other. Legacy stacks without that parameter can still use the reviewed migration procedure below.

Production's workflow checks the real environment configuration before planning and again before applying. Missing protection, a non-main ref, extra branch/tag rules, missing reviewers or enabled bypass cause failure. GitHub must support required reviewers for the repository's plan/visibility; if it does not, do not enable production deployment. Where a second reviewer is available, also enable prevention of self-review. [GitHub environment protection documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Protect `main` with required PR review and the CI check when GitHub Actions is available. Repository administrators remain privileged and can edit these settings, so environment protection is not a substitute for repository governance.

## Run a controlled application deployment

After the workflow has been reviewed and is available to GitHub Actions, select **Review and deploy → Run workflow → development**. Choose the reviewed branch/revision. The workflow:

1. Runs the same CI checks as a pull request.
2. Builds and packages the functions with the plan role.
3. Creates a CloudFormation Change Set using the scoped execution role.
4. Uploads the exact Change Set ARN, stack identity, revision, template digest and full paginated resource changes as a review artifact.
5. Waits for the apply environment's protection rules. For production, inspect the plan summary **before** approving.
6. Assumes the apply role and verifies the artifact/revision/stack/environment against CloudFormation before executing that exact Change Set.
7. Waits for stack completion; CodeDeploy manages subsequent HTTP alias updates.

PlanRole cannot execute a Change Set. DeployRole cannot create a different one or pass another execution role. The deployment concurrency group prevents overlapping application deployments within an environment. A failed or timed-out workflow does not imply AWS has stopped; inspect CloudFormation and CodeDeploy before retrying. Never cancel an active canary simply to start another run.

Application parameters omitted on update retain their prior values. Initial email parameters default to empty. The manual GitHub workflow uses the safe defaults and existing values; changing recipients requires a reviewed parameter change through the local planning path below. Do not store secrets in parameters: Change Sets and their review artifacts expose configuration.

### Local plan/apply equivalent

The following Bash commands use an already approved bootstrap and the operator's temporary credentials. Set the values from its outputs; keep the environment and revision consistent:

```bash
export AWS_REGION=sa-east-1
export STACK_NAME=orders-development
export ARTIFACT_BUCKET='<bootstrap ArtifactBucket output>'
export EXECUTION_ROLE='<bootstrap CloudFormationExecutionRole output>'
export REVISION="$(git rev-parse HEAD)"
mkdir -p .deploy
sam build
sam package --template-file .aws-sam/build/template.yaml --s3-bucket "$ARTIFACT_BUCKET" --region "$AWS_REGION" --output-template-file .deploy/packaged.yaml
python scripts/deployment.py plan --stack-name "$STACK_NAME" --environment development --revision "$REVISION" --region "$AWS_REGION" --artifact-bucket "$ARTIFACT_BUCKET" --execution-role "$EXECUTION_ROLE"
```

Review `.deploy/review.json`, especially replacements and IAM changes. After approval, the explicit mutation is:

```bash
python scripts/deployment.py apply --stack-name "$STACK_NAME" --environment development --revision "$REVISION" --region "$AWS_REGION"
```

Local operator credentials can bypass GitHub protections; the script is not a production approval mechanism. Use the gated workflow for production. The application deliberately retains its durable tables/user pool; do not interpret retention as a complete backup or migration strategy.

To enable an approved test SNS subscription or operational alerts, place string-valued overrides in an ignored `.deploy/parameters.json` and add `--parameters-file .deploy/parameters.json` to `plan`. Supported parameters are `TestNotificationEmail`, `AlarmEmail`, `OAuthCallbackUrl` and `EnvironmentName` (which must match the selected environment). Supply only recipients you are authorized to contact. SNS requires recipient confirmation. `AlarmEmail` also creates a customer-managed KMS key with an ongoing charge. Keeping both email values empty sends no email.

## Authenticate and run live tests

The operator needs CloudFormation read access, Cognito test-user administration, DynamoDB reads for the application's tables, and appropriate queue read/send/visibility permissions for the live test. Application users themselves need only the access token; they do not receive these operator permissions.

Create two development users with distinct usernames. Passwords are entered privately and are not stored or printed by the helper:

```bash
python scripts/create-demo-user.py --stack-name orders-development --username demo-alice --region sa-east-1
python scripts/create-demo-user.py --stack-name orders-development --username demo-bob --region sa-east-1
python scripts/login.py --stack-name orders-development --output .tokens/alice.token.json --region sa-east-1
python scripts/login.py --stack-name orders-development --output .tokens/bob.token.json --region sa-east-1
```

Sign in as the named user for each browser flow. If the browser retains a session, sign out before authenticating the second user. The helper uses state validation, PKCE, the default loopback callback and an exclusive local token file. A custom HTTPS callback requires a corresponding application frontend; the local helper intentionally rejects it. Protect `.tokens/` with your OS user permissions. Refresh expired tokens by removing only your expired token file or choosing a new filename.

Run the core live E2E test:

```bash
python scripts/smoke-test.py --stack-name orders-development --region sa-east-1 --token-file .tokens/alice.token.json --other-token-file .tokens/bob.token.json
```

This creates a real order and checks public health, unauthenticated rejection, malformed JSON, creation, replay, conflict, asynchronous processing, fulfillment persistence, ownership isolation, and the EventBridge→notification→SNS audit message. It writes `.deploy/live-report.json`. It leaves the order and audit message as evidence. An omitted second token is reported as a skipped live ownership check.

Queue inspection temporarily hides older messages so it can reach the test message, then restores every inspected message on success or failure. It never deletes messages and stops after 2,000 inspected records. Use isolated development queues; visibility changes can briefly affect queue metrics. If restoring visibility fails, the test fails and those messages become visible when their temporary timeout expires.

The optional DLQ exercise sends one duplicate and one deliberately malformed message. It causes a real alarm, takes roughly 15–20 minutes with the configured visibility/redrive policy, and retains the poison message in the DLQ:

```bash
python scripts/smoke-test.py --stack-name orders-development --region sa-east-1 --token-file .tokens/alice.token.json --other-token-file .tokens/bob.token.json --exercise-dlq --dlq-timeout 1200 --report .deploy/live-with-dlq.json
```

SQS does not guarantee these two messages land in the same Lambda invocation. Exact partial-batch semantics are covered by unit and DynamoDB Local tests; this live exercise proves managed retry/redrive and preservation of a final order. Do not label a skipped or timed-out exercise as passed.

## Verify canary and rollback

On the first deployment there is no earlier alias version to split. Establish a healthy baseline, then make a small compatible HTTP change and deploy a second revision. While CloudFormation is updating, inspect routing repeatedly:

```bash
python scripts/inspect-deployment.py --stack-name orders-development --region sa-east-1
```

The output includes each alias version, `AdditionalVersionWeights`, deployment ID/status, rollback information and errors. A healthy second deployment should show approximately 10% routing weight to the candidate during the ten-minute window, then no secondary weight after promotion. Counts from a small request sample do not have to equal exactly 10%.

Start bounded probes in a second terminal before applying the Change Set:

```bash
python scripts/canary-probe.py --stack-name orders-development --region sa-east-1 --seconds 720 --interval 1 --report .deploy/canary-probe.json
```

This makes at most roughly one public health request per second, records HTTP outcomes, and refuses production stacks. The resulting counts are observations, not an automatic claim that rollback occurred.

For a real rollback demonstration, use only an approved disposable development environment:

1. Save the baseline alias versions and successful deployment IDs.
2. Prepare a temporary development-only revision that returns HTTP 500 from the health handler. Keep the code change isolated and do not merge it.
3. Start continuous bounded health probes at roughly one request per second and deploy the candidate. Stop the exercise if it affects any other environment.
4. Capture actual 5xx responses, the API 5xx alarm entering ALARM, CodeDeploy failure/rollback details, and the alias returning to its baseline version. Inspect both CloudFormation and CodeDeploy; a static template test is not this evidence.
5. Revert the temporary fault, wait for alarms to return to OK and the stack to finish rollback, then deploy and verify the healthy revision.

The shared API alarm can roll back multiple HTTP deployment groups conservatively. A low-traffic canary without probes may not produce enough candidate requests to trigger an alarm. Worker updates are not canaried; they rely on backwards-compatible messages/data and idempotency. Never roll back to code that cannot understand already committed records.

## Migrating an existing stack

Resource logical IDs for the original orders table, queue and functions are preserved. New tables and event routing are added. The original orders-table stream remains defined but no longer drives publication; the publisher mapping now consumes the outbox stream.

The Cognito change is an intentional authentication migration: old SigV4/IAM clients must obtain Cognito access tokens and scopes. New orders use the Cognito `sub` as `ownerId`. Legacy IAM-owned or ownerless records will not automatically become visible to a Cognito user. Never infer ownership from `customerId`.

Before updating a stack containing valuable data, export/backup it and prepare an explicitly reviewed mapping from each known legacy order to its verified Cognito owner. Add missing `updatedAt` only under a conditional migration that preserves existing values. For known legacy `RECEIVED` orders created before the outbox existed, an operator can enqueue the validated `{ "orderId": "..." }` after checking the row. The new outbox reconciler cannot discover missing historical intents. Avoid unbounded table scans in normal operations; a one-time inventory/export is a separate authorized migration.

Existing `PROCESSED` records remain final and are not automatically turned into new fulfillment tickets or retroactive notifications. Authentication changes can also affect an old version during the first canary, so use a dedicated development stack or plan a maintenance migration when upgrading from the IAM-only version. Review resource replacements and old-version compatibility before approving the Change Set.
