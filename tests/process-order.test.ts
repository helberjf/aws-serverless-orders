import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { lambdaHandler } from '../src/process-order/app';
import { mockClients, orderId, receivedOrder, sqsEvent, failure } from './support';
describe('fulfillment processing', () => {
    let clients: ReturnType<typeof mockClients>;
    const message = JSON.stringify({ orderId });
    beforeEach(() => {
        clients = mockClients();
        clients.dynamo.mockImplementation(async (command) =>
            command instanceof GetCommand ? { Item: receivedOrder } : {},
        );
    });
    it('commits the status, fulfillment ticket and OrderProcessed intent together', async () => {
        expect(await lambdaHandler(sqsEvent(message))).toEqual({ batchItemFailures: [] });
        const write = clients.dynamo.mock.calls[1][0] as TransactWriteCommand;
        expect(write).toBeInstanceOf(TransactWriteCommand);
        expect(write.input.TransactItems).toHaveLength(3);
        expect(write.input.TransactItems![0].Update?.ConditionExpression).toContain('updatedAt = :version');
        expect(write.input.TransactItems![1].Put?.Item).toMatchObject({
            orderId,
            quantity: 2,
            status: 'READY_FOR_FULFILLMENT',
        });
        expect(write.input.TransactItems![2].Put?.Item).toMatchObject({
            eventType: 'OrderProcessed',
            deliveryStatus: 'PENDING',
        });
    });
    it('acknowledges processed duplicates without writing again', async () => {
        clients.dynamo.mockResolvedValue({ Item: { ...receivedOrder, status: 'PROCESSED' } });
        expect(await lambdaHandler(sqsEvent(message, message))).toEqual({ batchItemFailures: [] });
        expect(clients.dynamo.mock.calls.every(([c]) => c instanceof GetCommand)).toBe(true);
    });
    it.each([undefined, { ...receivedOrder, status: 'CANCELLED' }, { ...receivedOrder, quantity: 0 }])(
        'retries missing or invalid orders',
        async (Item) => {
            clients.dynamo.mockResolvedValue({ Item });
            expect(await lambdaHandler(sqsEvent(message))).toEqual({
                batchItemFailures: [{ itemIdentifier: 'message-0' }],
            });
        },
    );
    it('accepts a concurrent winning transaction', async () => {
        clients.dynamo
            .mockResolvedValueOnce({ Item: receivedOrder })
            .mockRejectedValueOnce(failure('TransactionCanceledException'))
            .mockResolvedValueOnce({ Item: { ...receivedOrder, status: 'PROCESSED' } });
        expect(await lambdaHandler(sqsEvent(message))).toEqual({ batchItemFailures: [] });
    });
    it('retries a failed transaction that did not complete', async () => {
        clients.dynamo
            .mockResolvedValueOnce({ Item: receivedOrder })
            .mockRejectedValueOnce(failure())
            .mockResolvedValueOnce({ Item: receivedOrder });
        expect(await lambdaHandler(sqsEvent(message))).toEqual({
            batchItemFailures: [{ itemIdentifier: 'message-0' }],
        });
    });
    it('handles a mixed batch without repeating successful records', async () => {
        let reads = 0;
        clients.dynamo.mockImplementation(async (command) => {
            if (command instanceof GetCommand) {
                if (++reads === 2) throw failure();
                return { Item: receivedOrder };
            }
            return {};
        });
        expect(await lambdaHandler(sqsEvent(message, message, message))).toEqual({
            batchItemFailures: [{ itemIdentifier: 'message-1' }],
        });
        expect(clients.dynamo.mock.calls.filter(([c]) => c instanceof TransactWriteCommand)).toHaveLength(2);
    });
    it.each(['{', 'null', '[]', '{}', '{"orderId":5}', '{"orderId":"bad"}'])(
        'retries malformed messages %s',
        async (body) => {
            expect(await lambdaHandler(sqsEvent(body))).toEqual({
                batchItemFailures: [{ itemIdentifier: 'message-0' }],
            });
            expect(clients.dynamo).not.toHaveBeenCalled();
        },
    );
    it('handles an empty batch', async () => {
        expect(await lambdaHandler(sqsEvent())).toEqual({ batchItemFailures: [] });
    });
});
