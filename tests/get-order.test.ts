import { lambdaHandler } from '../src/get-order/app';
import { apiEvent, mockClients, receivedOrder, failure } from './support';
describe('GET order ownership', () => {
    let clients: ReturnType<typeof mockClients>;
    beforeEach(() => {
        clients = mockClients();
    });
    it('returns the authenticated owner order', async () => {
        clients.dynamo.mockResolvedValue({ Item: receivedOrder });
        const result = await lambdaHandler(apiEvent());
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body)).not.toHaveProperty('ownerId');
        expect(clients.dynamo.mock.calls[0][0].input.ConsistentRead).toBe(true);
    });
    it.each([undefined, { ...receivedOrder, ownerId: 'other-user' }, { ...receivedOrder, ownerId: undefined }])(
        'does not reveal absent or inaccessible orders',
        async (Item) => {
            clients.dynamo.mockResolvedValue({ Item });
            expect((await lambdaHandler(apiEvent())).statusCode).toBe(404);
        },
    );
    it.each([null, {}, { orderId: 'invalid' }])('rejects malformed paths', async (pathParameters) => {
        expect((await lambdaHandler({ ...apiEvent(), pathParameters })).statusCode).toBe(400);
    });
    it('returns 500 on database errors', async () => {
        clients.dynamo.mockRejectedValue(failure());
        expect((await lambdaHandler(apiEvent())).statusCode).toBe(500);
    });
});
