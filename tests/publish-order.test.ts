import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { lambdaHandler } from '../src/publish-order/app';
import { mockClients, orderId, streamEvent, streamRecord } from './support';

describe('DynamoDB Streams publisher', () => {
    let clients: ReturnType<typeof mockClients>;
    beforeEach(() => {
        clients = mockClients();
    });

    it('publishes a committed insert as an order ID message', async () => {
        expect(await lambdaHandler(streamEvent(streamRecord()))).toEqual({ batchItemFailures: [] });
        const command = clients.sqs.mock.calls[0][0];
        expect(command).toBeInstanceOf(SendMessageCommand);
        expect(command.input).toEqual({
            QueueUrl: process.env.ORDERS_QUEUE_URL,
            MessageBody: JSON.stringify({ orderId }),
        });
        expect(clients.dynamo).not.toHaveBeenCalled();
    });

    it('ignores status modifications and deleted items to prevent event loops', async () => {
        expect(await lambdaHandler(streamEvent(streamRecord('1', 'MODIFY'), streamRecord('2', 'REMOVE')))).toEqual({
            batchItemFailures: [],
        });
        expect(clients.sqs).not.toHaveBeenCalled();
    });

    it('stops at a failed publish and returns the stream sequence number for retry', async () => {
        clients.sqs.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('SQS unavailable'));
        expect(await lambdaHandler(streamEvent(streamRecord('10'), streamRecord('11'), streamRecord('12')))).toEqual({
            batchItemFailures: [{ itemIdentifier: '11' }],
        });
        expect(clients.sqs).toHaveBeenCalledTimes(2);
    });

    it.each<NonNullable<DynamoDBRecord['dynamodb']>>([{}, { Keys: {} }, { Keys: { orderId: { S: 'not-a-uuid' } } }])(
        'retries malformed records %j',
        async (dynamodb) => {
            expect(
                await lambdaHandler(
                    streamEvent({ eventName: 'INSERT', dynamodb: { ...dynamodb, SequenceNumber: '2' } }),
                ),
            ).toEqual({ batchItemFailures: [{ itemIdentifier: '2' }] });
            expect(clients.sqs).not.toHaveBeenCalled();
        },
    );

    it('fails the batch when there is no usable retry sequence number', async () => {
        await expect(lambdaHandler(streamEvent({ eventName: 'INSERT' }))).rejects.toThrow('Invalid order ID');
    });

    it('tolerates replayed inserts (the consumer owns deduplication)', async () => {
        await lambdaHandler(streamEvent(streamRecord()));
        await lambdaHandler(streamEvent(streamRecord()));
        expect(clients.sqs).toHaveBeenCalledTimes(2);
    });
});
import type { DynamoDBRecord } from 'aws-lambda';
