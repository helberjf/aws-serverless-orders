import { createHash, randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, requiredEnv } from './clients';
import { HttpError } from './http';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export function requestKey(event: APIGatewayProxyEvent): string {
    const multiple = Object.entries(event.multiValueHeaders ?? {})
        .filter(([key]) => key.toLowerCase() === 'idempotency-key')
        .flatMap(([, values]) => values ?? []);
    const values = multiple.length
        ? multiple
        : Object.entries(event.headers ?? {})
              .filter(([key]) => key.toLowerCase() === 'idempotency-key')
              .map(([, value]) => value);
    if (!values.length) return randomUUID();
    if (values.length !== 1 || typeof values[0] !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(values[0])) {
        throw new HttpError(
            400,
            'INVALID_IDEMPOTENCY_KEY',
            'Idempotency-Key must be one 1-128 character token (letters, digits, . _ : -)',
        );
    }
    return values[0];
}
export async function previousResponse(
    idempotencyKey: string,
    requestHash: string,
    now: number,
): Promise<Record<string, unknown> | undefined> {
    const { Item } = await documentClient.send(
        new GetCommand({ TableName: requiredEnv('IDEMPOTENCY_TABLE'), Key: { idempotencyKey }, ConsistentRead: true }),
    );
    if (!Item || Number(Item.expiresAt) <= now) return undefined;
    if (Item.requestHash !== requestHash)
        throw new HttpError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key was already used with different order data',
        );
    return Item.response as Record<string, unknown>;
}
