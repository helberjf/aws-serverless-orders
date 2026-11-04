import type { APIGatewayProxyEvent } from 'aws-lambda';
import { z } from 'zod';
import { HttpError } from './http';
import { requiredEnv } from './clients';

const claimsSchema = z.object({
    sub: z.string().min(1).max(128),
    token_use: z.literal('access'),
    client_id: z.string(),
    iss: z.string(),
    exp: z.coerce.number().int(),
    scope: z.string(),
});
export function requireOwner(event: APIGatewayProxyEvent, scope: 'orders/read' | 'orders/write'): string {
    // API Gateway validates the Cognito JWT signature and issuer before invoking this function.
    // Check client binding, token type, expiry and operation scope again at the application boundary.
    const claims = claimsSchema.safeParse(event.requestContext?.authorizer?.claims);
    if (!claims.success || claims.data.exp <= Math.floor(Date.now() / 1000)) {
        throw new HttpError(401, 'UNAUTHORIZED', 'A valid Cognito access token is required');
    }
    if (
        claims.data.client_id !== requiredEnv('COGNITO_CLIENT_ID') ||
        claims.data.iss !== requiredEnv('COGNITO_ISSUER')
    ) {
        throw new HttpError(401, 'UNAUTHORIZED', 'A valid Cognito access token is required');
    }
    if (!claims.data.scope.split(' ').includes(scope))
        throw new HttpError(403, 'FORBIDDEN', 'The token does not grant this operation');
    return claims.data.sub;
}
