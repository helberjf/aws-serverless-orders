import type { APIGatewayProxyResult } from 'aws-lambda';

export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(body),
    };
}

export function logError(event: string, error: unknown, context: Record<string, unknown>): void {
    // Log identifiers and error types, never customer payloads or AWS credentials.
    console.error({ event, ...context, errorType: error instanceof Error ? error.name : 'UnknownError' });
}
