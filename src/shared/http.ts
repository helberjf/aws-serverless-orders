import { count, instrument, logger } from './telemetry';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export class HttpError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: string,
        message: string,
    ) {
        super(message);
    }
}
export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(body),
    };
}
export function logError(eventType: string, error: unknown, context: Record<string, unknown>): void {
    count('OperationFailures');
    logger.error(eventType, { eventType, ...context, errorType: error instanceof Error ? error.name : 'UnknownError' });
}
export function apiHandler(
    operation: string,
    handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>,
) {
    return instrument(operation, async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
        const requestId = event.requestContext?.requestId ?? 'unknown';
        let response: APIGatewayProxyResult;
        try {
            response = await handler(event);
        } catch (error) {
            if (error instanceof HttpError)
                response = jsonResponse(error.statusCode, { code: error.code, message: error.message, requestId });
            else {
                logError(`${operation}_failed`, error, { requestId });
                response = jsonResponse(500, { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId });
            }
        }
        count('HttpRequests');
        if (response.statusCode >= 500) count('HttpServerErrors');
        logger.info('http_request_completed', {
            eventType: 'http_request_completed',
            operation,
            requestId,
            status: response.statusCode,
            orderId: event.pathParameters?.orderId,
        });
        return { ...response, headers: { ...response.headers, 'X-Request-Id': requestId } };
    });
}
export function parseBody(event: APIGatewayProxyEvent): unknown {
    if (!event.body) throw new HttpError(400, 'INVALID_REQUEST', 'Request body is required');
    if (Buffer.byteLength(event.body, 'utf8') > 16384)
        throw new HttpError(400, 'INVALID_REQUEST', 'Request body is too large');
    try {
        return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
    } catch {
        throw new HttpError(400, 'INVALID_JSON', 'Request body must contain valid JSON');
    }
}
