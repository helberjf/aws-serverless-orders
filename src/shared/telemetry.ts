import type { Context } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

const serviceName = process.env.POWERTOOLS_SERVICE_NAME ?? 'aws-serverless-orders';
export const logger = new Logger({ serviceName });
export const metrics = new Metrics({ namespace: 'AWSOrders', serviceName });
export const tracer = new Tracer({ serviceName });
export const count = (name: string, value = 1): void => {
    metrics.addMetric(name, MetricUnit.Count, value);
};
export function logInfo(fields: Record<string, unknown>): void {
    logger.info(String(fields.eventType), fields);
}
export function instrument<T, R>(operation: string, handler: (event: T) => Promise<R>) {
    return async (event: T, context?: Context): Promise<R> => {
        const started = Date.now();
        count('Invocations');
        const parent = tracer.isTracingEnabled() ? tracer.getSegment() : undefined;
        const segment = parent?.addNewSubsegment(`## ${operation}`);
        if (segment) {
            tracer.setSegment(segment);
            tracer.putAnnotation('operation', operation);
        }
        try {
            return await handler(event);
        } catch (error) {
            count('UnhandledErrors');
            segment?.addFaultFlag();
            throw error;
        } finally {
            segment?.close();
            if (parent) tracer.setSegment(parent);
            logInfo({
                eventType: 'invocation_completed',
                operation,
                requestId: context?.awsRequestId,
                durationMs: Date.now() - started,
            });
            // Telemetry delivery must not change the business result or mask its error.
            try {
                metrics.publishStoredMetrics();
            } catch {
                logger.warn('metrics_flush_failed', { eventType: 'metrics_flush_failed', operation });
            }
        }
    };
}
