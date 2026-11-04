import { lambdaHandler as create } from '../src/create-order/app';
import { lambdaHandler as get } from '../src/get-order/app';
import { apiEvent, mockClients, receivedOrder } from './support';

describe('Cognito access-token and ownership boundary', () => {
    beforeEach(() => {
        mockClients();
    });
    it.each([
        { token_use: 'id' },
        { client_id: 'another-client' },
        { iss: 'https://untrusted.example' },
        { exp: '0' },
        { exp: 'not-a-date' },
        { sub: '' },
    ])('rejects invalid claims %j', async (changes) => {
        const event = apiEvent();
        Object.assign(event.requestContext.authorizer!.claims, changes);
        expect((await create(event)).statusCode).toBe(401);
    });
    it('rejects missing write scope even with an otherwise valid identity', async () => {
        const event = apiEvent();
        event.requestContext.authorizer!.claims.scope = 'orders/read';
        expect((await create(event)).statusCode).toBe(403);
    });
    it('rejects missing read scope', async () => {
        const event = apiEvent();
        event.requestContext.authorizer!.claims.scope = 'orders/write';
        expect((await get(event)).statusCode).toBe(403);
    });
    it('does not treat an IAM principal or body customerId as a Cognito identity', async () => {
        const event = apiEvent();
        event.requestContext.authorizer = null;
        event.requestContext.identity = {
            userArn: 'arn:aws:iam::123456789012:user/operator',
        } as typeof event.requestContext.identity;
        expect((await create(event)).statusCode).toBe(401);
    });
    it('binds read access to the verified subject rather than the request body', async () => {
        const clients = mockClients();
        clients.dynamo.mockResolvedValue({ Item: receivedOrder });
        const event = apiEvent();
        event.requestContext.authorizer!.claims.sub = 'user-b';
        expect((await get(event)).statusCode).toBe(404);
    });
    it('fails safely if client-binding configuration is absent', async () => {
        const value = process.env.COGNITO_CLIENT_ID;
        delete process.env.COGNITO_CLIENT_ID;
        try {
            expect((await create(apiEvent())).statusCode).toBe(500);
        } finally {
            process.env.COGNITO_CLIENT_ID = value;
        }
    });
});
