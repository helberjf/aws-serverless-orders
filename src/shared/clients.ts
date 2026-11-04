import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SNSClient } from '@aws-sdk/client-sns';

// Endpoint overrides are used only by isolated local integration tests.
export const documentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
    }),
    { marshallOptions: { removeUndefinedValues: true } },
);
export const sqsClient = new SQSClient({});
export const eventBridgeClient = new EventBridgeClient({});
export const snsClient = new SNSClient({});
export function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
}
