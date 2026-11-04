import type { APIGatewayProxyEvent, DynamoDBRecord, DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { documentClient, sqsClient } from '../src/shared/clients';

export const orderId = 'd73b82b5-bcf4-4aae-a3b3-0e726019f8e0';
export const input = { customerId: 'customer-123', productId: 'product-ABC', quantity: 2 };
type SendMock = jest.SpyInstance<Promise<Record<string, unknown>>, [{ input: Record<string, unknown> }]>;

export function mockClients(): { dynamo: SendMock; sqs: SendMock } {
    const dynamo = jest.spyOn(documentClient, 'send') as unknown as SendMock;
    const sqs = jest.spyOn(sqsClient, 'send') as unknown as SendMock;
    dynamo.mockResolvedValue({});
    sqs.mockResolvedValue({});
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    return { dynamo, sqs };
}

export function apiEvent(body: string | null = JSON.stringify(input)): APIGatewayProxyEvent {
    return {
        body,
        isBase64Encoded: false,
        pathParameters: { orderId },
        requestContext: { requestId: 'test-request' },
    } as unknown as APIGatewayProxyEvent;
}

export function sqsEvent(...bodies: string[]): SQSEvent {
    return { Records: bodies.map((body, index) => ({ body, messageId: `message-${index}` })) } as SQSEvent;
}

export function streamRecord(sequence = '1', eventName: DynamoDBRecord['eventName'] = 'INSERT'): DynamoDBRecord {
    return {
        eventID: `event-${sequence}`,
        eventName,
        dynamodb: { SequenceNumber: sequence, Keys: { orderId: { S: orderId } } },
    };
}

export function streamEvent(...records: DynamoDBRecord[]): DynamoDBStreamEvent {
    return { Records: records };
}

export function conditionalFailure(): Error {
    return Object.assign(new Error('Condition not met'), { name: 'ConditionalCheckFailedException' });
}
