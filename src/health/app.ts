import { apiHandler, jsonResponse } from '../shared/http';

// Liveness only: intentionally does not call AWS services or expose configuration.
export const lambdaHandler = apiHandler('health', async () =>
    jsonResponse(200, { status: 'ok', service: 'aws-serverless-orders' }),
);
