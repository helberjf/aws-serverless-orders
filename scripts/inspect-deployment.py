"""Read deployed aliases, routing weights and CodeDeploy results; never modify AWS."""
import argparse
import json
import boto3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack-name', required=True)
    parser.add_argument('--region', default='sa-east-1')
    args = parser.parse_args()
    session = boto3.Session(region_name=args.region)
    stack = session.client('cloudformation').describe_stacks(StackName=args.stack_name)['Stacks'][0]
    outputs = {item['OutputKey']: item['OutputValue'] for item in stack['Outputs']}
    functions = session.client('lambda')
    deploy = session.client('codedeploy')
    report = {'stackStatus': stack['StackStatus'], 'functions': []}
    for name in ('CreateOrderFunction', 'GetOrderFunction', 'HealthFunction'):
        arn = outputs[name + 'LiveAlias']
        alias = functions.get_alias(FunctionName=arn.rsplit(':', 1)[0], Name='live')
        group = deploy.get_deployment_group(applicationName=outputs['CodeDeployApplication'], deploymentGroupName=outputs[name + 'DeploymentGroup'])['deploymentGroupInfo']
        last = group.get('lastAttemptedDeployment', {}).get('deploymentId')
        item = {'function': name, 'version': alias['FunctionVersion'], 'weights': alias.get('RoutingConfig', {}).get('AdditionalVersionWeights', {}), 'lastDeploymentId': last}
        if last:
            deployment = deploy.get_deployment(deploymentId=last)['deploymentInfo']
            item.update(status=deployment['status'], rollback=deployment.get('rollbackInfo'), error=deployment.get('errorInformation'))
        report['functions'].append(item)
    print(json.dumps(report, indent=2, default=str))


if __name__ == '__main__':
    main()
