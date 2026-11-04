import type { APIGatewayProxyEvent } from 'aws-lambda';
import { HttpError } from './http';

export function requireOwner(event: APIGatewayProxyEvent): string {
    const subject: unknown = event.requestContext?.authorizer?.claims?.sub;
    if (typeof subject === 'string' && subject.length > 0) return subject;
    const arn = event.requestContext?.identity?.userArn;
    if (arn) return arn;
    throw new HttpError(401, 'UNAUTHORIZED', 'Authentication is required');
}
