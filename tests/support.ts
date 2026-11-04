import type { APIGatewayProxyEvent, DynamoDBRecord, DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import type { MockInstance } from 'vitest';
import { documentClient, eventBridgeClient, snsClient, sqsClient } from '../src/shared/clients';
import type { Order } from '../src/shared/order';

export const orderId = 'd73b82b5-bcf4-4aae-a3b3-0e726019f8e0';
export const input = { customerId: 'customer-123', productId: 'product-ABC', quantity: 2 };
export const receivedOrder: Order = {
    orderId,
    ...input,
    ownerId: 'user-a',
    status: 'RECEIVED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};
export type SendMock = MockInstance<(command: { input: Record<string, unknown> }) => Promise<Record<string, unknown>>>;
export function mockClients() {
    const dynamo = vi.spyOn(documentClient, 'send') as unknown as SendMock;
    const sqs = vi.spyOn(sqsClient, 'send') as unknown as SendMock;
    const events = vi.spyOn(eventBridgeClient, 'send') as unknown as SendMock;
    const sns = vi.spyOn(snsClient, 'send') as unknown as SendMock;
    dynamo.mockResolvedValue({});
    sqs.mockResolvedValue({ MessageId: 'sent' });
    events.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'accepted' }] });
    sns.mockResolvedValue({ MessageId: 'notification' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    return { dynamo, sqs, events, sns };
}
export function apiEvent(body: string | null = JSON.stringify(input)): APIGatewayProxyEvent {
    return {
        body,
        isBase64Encoded: false,
        headers: { 'Idempotency-Key': 'request-1' },
        pathParameters: { orderId },
        requestContext: { requestId: 'test-request', authorizer: { claims: { sub: 'user-a' } } },
    } as unknown as APIGatewayProxyEvent;
}
export function sqsEvent(...bodies: string[]): SQSEvent {
    return { Records: bodies.map((body, index) => ({ body, messageId: `message-${index}` })) } as SQSEvent;
}
export function streamRecord(sequence = '1', eventName: DynamoDBRecord['eventName'] = 'INSERT'): DynamoDBRecord {
    return {
        eventID: `stream-${sequence}`,
        eventName,
        dynamodb: { SequenceNumber: sequence, Keys: { eventId: { S: `OrderCreated:${orderId}` } } },
    };
}
export function streamEvent(...records: DynamoDBRecord[]): DynamoDBStreamEvent {
    return { Records: records };
}
export function failure(name = 'ConditionalCheckFailedException'): Error {
    return Object.assign(new Error('sensitive details'), { name });
}
