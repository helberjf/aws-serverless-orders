import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { lambdaHandler } from '../src/reconcile-outbox/app';
import { outboxItem } from '../src/shared/outbox';
import { mockClients, orderId } from './support';
describe('scheduled reconciliation', () => {
    it('queries pending work instead of scanning orders and drains paginated results', async () => {
        const clients = mockClients();
        let pages = 0;
        clients.dynamo.mockImplementation(async (command) => {
            if (command instanceof QueryCommand) {
                pages++;
                return pages === 1
                    ? { Items: [{ eventId: 'one' }], LastEvaluatedKey: { eventId: 'one' } }
                    : { Items: [{ eventId: 'two' }] };
            }
            if (command instanceof GetCommand)
                return { Item: outboxItem('OrderCreated', orderId, {}, new Date(Date.now() - 1000).toISOString()) };
            return {};
        });
        expect(await lambdaHandler()).toEqual({ attempted: 2, failed: 0 });
        expect(clients.dynamo.mock.calls[0][0].input.IndexName).toBe('PendingByNextAttempt');
        expect(clients.sqs).toHaveBeenCalledTimes(2);
    });
    it('continues after one failed pending record', async () => {
        const clients = mockClients();
        clients.dynamo.mockResolvedValueOnce({ Items: [{ eventId: 'missing' }] }).mockResolvedValue({});
        expect(await lambdaHandler()).toEqual({ attempted: 1, failed: 1 });
    });
    it('accepts an empty result', async () => {
        mockClients();
        expect(await lambdaHandler()).toEqual({ attempted: 0, failed: 0 });
    });
});
