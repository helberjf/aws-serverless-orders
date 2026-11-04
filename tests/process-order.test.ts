import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { lambdaHandler } from '../src/process-order/app';
import { conditionalFailure, mockClients, orderId, sqsEvent } from './support';

describe('SQS order processor', () => {
    let clients: ReturnType<typeof mockClients>;
    const message = JSON.stringify({ orderId });
    beforeEach(() => {
        clients = mockClients();
    });

    it('atomically processes only an existing RECEIVED order', async () => {
        expect(await lambdaHandler(sqsEvent(message))).toEqual({ batchItemFailures: [] });
        const command = clients.dynamo.mock.calls[0][0];
        expect(command).toBeInstanceOf(UpdateCommand);
        expect(command.input).toMatchObject({
            TableName: 'test-orders',
            Key: { orderId },
            ConditionExpression: 'attribute_exists(orderId) AND #status = :received',
            ExpressionAttributeValues: {
                ':received': 'RECEIVED',
                ':processed': 'PROCESSED',
                ':processedAt': expect.any(String),
            },
        });
        expect(clients.dynamo).toHaveBeenCalledTimes(1);
    });

    it('acknowledges a duplicate without overwriting its original processing timestamp', async () => {
        clients.dynamo
            .mockRejectedValueOnce(conditionalFailure())
            .mockResolvedValueOnce({ Item: { orderId, status: 'PROCESSED', processedAt: 'original' } });
        expect(await lambdaHandler(sqsEvent(message))).toEqual({ batchItemFailures: [] });
        const read = clients.dynamo.mock.calls[1][0];
        expect(read).toBeInstanceOf(GetCommand);
        expect(read.input).toMatchObject({ Key: { orderId }, ConsistentRead: true });
        expect(clients.dynamo).toHaveBeenCalledTimes(2);
    });

    it.each([{}, { Item: { status: 'RECEIVED' } }, { Item: { status: 'CANCELLED' } }])(
        'does not acknowledge missing or unexpected states: %j',
        async (result) => {
            clients.dynamo.mockRejectedValueOnce(conditionalFailure()).mockResolvedValueOnce(result);
            expect(await lambdaHandler(sqsEvent(message))).toEqual({
                batchItemFailures: [{ itemIdentifier: 'message-0' }],
            });
        },
    );

    it('retries if confirming a duplicate fails', async () => {
        clients.dynamo.mockRejectedValueOnce(conditionalFailure()).mockRejectedValueOnce(new Error('read failed'));
        expect(await lambdaHandler(sqsEvent(message))).toEqual({
            batchItemFailures: [{ itemIdentifier: 'message-0' }],
        });
    });

    it('reports only failed messages and continues processing a mixed batch', async () => {
        clients.dynamo
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error('throttled'))
            .mockResolvedValueOnce({});
        expect(await lambdaHandler(sqsEvent(message, message, message))).toEqual({
            batchItemFailures: [{ itemIdentifier: 'message-1' }],
        });
        expect(clients.dynamo).toHaveBeenCalledTimes(3);
    });

    it.each(['bad-json', 'null', '[]', '{}', '{"orderId":42}', '{"orderId":"invalid"}'])(
        'retries a poison message %s for eventual DLQ delivery',
        async (body) => {
            expect(await lambdaHandler(sqsEvent(body))).toEqual({
                batchItemFailures: [{ itemIdentifier: 'message-0' }],
            });
            expect(clients.dynamo).not.toHaveBeenCalled();
        },
    );

    it('returns success for an empty batch', async () => {
        expect(await lambdaHandler(sqsEvent())).toEqual({ batchItemFailures: [] });
    });

    it('handles non-Error failures without acknowledging the message', async () => {
        clients.dynamo.mockRejectedValue('unavailable');
        expect(await lambdaHandler(sqsEvent(message))).toEqual({
            batchItemFailures: [{ itemIdentifier: 'message-0' }],
        });
    });
});
