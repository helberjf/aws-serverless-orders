import type { Context } from 'aws-lambda';
import { Segment } from 'aws-xray-sdk-core';
import { instrument, logger, metrics, tracer } from '../src/shared/telemetry';

describe('observability boundaries', () => {
    it('records duration and request ID without logging payloads', async () => {
        const log = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
        const flush = vi.spyOn(metrics, 'publishStoredMetrics').mockImplementation(() => metrics);
        vi.spyOn(tracer, 'isTracingEnabled').mockReturnValue(true);
        const parent = new Segment('test');
        const segment = parent.addNewSubsegment('test_operation');
        vi.spyOn(parent, 'addNewSubsegment').mockReturnValue(segment);
        const close = vi.spyOn(segment, 'close').mockImplementation(() => undefined);
        vi.spyOn(tracer, 'getSegment').mockReturnValue(parent);
        const set = vi.spyOn(tracer, 'setSegment').mockImplementation(() => undefined);
        const annotate = vi.spyOn(tracer, 'putAnnotation').mockImplementation(() => undefined);
        const handler = instrument<{ secret: string }, { status: string }>('test_operation', async () => ({
            status: 'ok',
        }));
        expect(await handler({ secret: 'must-not-be-logged' }, { awsRequestId: 'request-1' } as Context)).toEqual({
            status: 'ok',
        });
        expect(log).toHaveBeenCalledWith(
            'invocation_completed',
            expect.objectContaining({ requestId: 'request-1', durationMs: expect.any(Number) }),
        );
        expect(JSON.stringify(log.mock.calls)).not.toContain('must-not-be-logged');
        expect(annotate).toHaveBeenCalledWith('operation', 'test_operation');
        expect(flush).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
        expect(set.mock.calls).toEqual([[segment], [parent]]);
    });
    it('preserves the business error when metrics cannot flush', async () => {
        vi.spyOn(logger, 'info').mockImplementation(() => undefined);
        vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        vi.spyOn(metrics, 'publishStoredMetrics').mockImplementation(() => {
            throw new Error('metrics failure');
        });
        const problem = new Error('business failure');
        const handler = instrument('test_failure', async () => {
            throw problem;
        });
        await expect(handler({})).rejects.toBe(problem);
    });
});
