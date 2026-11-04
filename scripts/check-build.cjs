// Load the actual SAM bundles under Node 24, without making AWS requests.
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.POWERTOOLS_TRACE_ENABLED = 'false';
process.env.POWERTOOLS_METRICS_DISABLED = 'true';
process.env.POWERTOOLS_LOG_LEVEL = 'SILENT';
const names = [
    'CreateOrderFunction',
    'GetOrderFunction',
    'HealthFunction',
    'PublishOrderFunction',
    'ProcessOrderFunction',
    'NotifyOrderFunction',
    'ReconcileOutboxFunction',
];
async function main() {
    for (const name of names) {
        const bundle = require(path.resolve('.aws-sam/build', name, 'app.js'));
        assert.equal(typeof bundle.lambdaHandler, 'function', `${name} handler is missing`);
        if (name === 'HealthFunction') {
            const response = await bundle.lambdaHandler({ requestContext: { requestId: 'build-check' } });
            assert.equal(response.statusCode, 200);
            assert.deepEqual(JSON.parse(response.body), { status: 'ok', service: 'aws-serverless-orders' });
        }
    }
    console.log('All seven SAM bundles export their handlers; built health handler returned 200.');
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
