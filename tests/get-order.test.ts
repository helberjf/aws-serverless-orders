import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { lambdaHandler } from '../src/get-order/app';
import { apiEvent, input, mockClients, orderId } from './support';

describe('GET /orders/{orderId}', () => {
    let clients: ReturnType<typeof mockClients>;
    beforeEach(() => {
        clients = mockClients();
    });

    it('reads the current order status with a strongly consistent read', async () => {
        const order = { orderId, ...input, status: 'PROCESSED', processedAt: '2026-11-04T10:00:00.000Z' };
        clients.dynamo.mockResolvedValue({ Item: order });
        const response = await lambdaHandler(apiEvent(null));
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(order);
        const command = clients.dynamo.mock.calls[0][0];
        expect(command).toBeInstanceOf(GetCommand);
        expect(command.input).toEqual({ TableName: 'test-orders', Key: { orderId }, ConsistentRead: true });
    });

    it('returns 404 for a missing order', async () => {
        expect((await lambdaHandler(apiEvent())).statusCode).toBe(404);
    });

    it.each([null, {}, { orderId: 'invalid' }, { orderId: '' }])(
        'rejects an invalid path %j',
        async (pathParameters) => {
            expect((await lambdaHandler({ ...apiEvent(), pathParameters })).statusCode).toBe(400);
            expect(clients.dynamo).not.toHaveBeenCalled();
        },
    );

    it('returns 500 on a database error', async () => {
        clients.dynamo.mockRejectedValue(new Error('unavailable'));
        expect((await lambdaHandler(apiEvent())).statusCode).toBe(500);
    });
});
