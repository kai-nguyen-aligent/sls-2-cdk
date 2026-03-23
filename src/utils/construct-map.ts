import type { CdkMapping } from '../types/index.js';
import { RawTs, valueToTs } from './cfn-to-ts.js';

/**
 * Suffixes appended by Serverless Framework to CloudFormation logical IDs.
 * Stripped when generating CDK construct IDs.
 */
export const SLS_LOGICAL_ID_SUFFIXES = ['LambdaFunction', 'LambdaLayer'] as const;

/**
 * Logical IDs of CloudFormation resources to skip during construct generation.
 * These are Serverless Framework infrastructure resources that should not be
 * migrated to CDK constructs.
 */
export const IGNORE_LOGICAL_IDS = new Set<string>([
    'ServerlessDeploymentBucket',
    'ServerlessDeploymentBucketPolicy',
    'IamRoleLambdaExecution',
]);

/**
 * Explicit mapping of CloudFormation resource types to CDK L2 constructs.
 * Resources not in this map are skipped during generation.
 */
export const CFN_TO_CDK: Record<string, CdkMapping> = {
    // Lambda
    'AWS::Lambda::Function': {
        cdkModule: 'aws-cdk-lib/aws-lambda-nodejs',
        importAlias: 'lambdaNodejs',
        className: 'NodejsFunction',
        cfnNameProp: 'FunctionName',
        omitProps: new Set(['Code', 'Handler', 'Runtime', 'Role', 'TracingConfig']),
        propExpansions: new Map<
            string,
            (v: unknown, allProps: Record<string, unknown>) => Record<string, unknown>
        >([
            [
                'Timeout',
                v => ({
                    timeout: typeof v === 'number' ? new RawTs(`cdk.Duration.seconds(${v})`) : v,
                }),
            ],
            [
                'Environment',
                v => ({
                    environment:
                        v && typeof v === 'object' && 'Variables' in (v as Record<string, unknown>)
                            ? (v as Record<string, unknown>)['Variables']
                            : v,
                }),
            ],
            [
                'VpcConfig',
                v => {
                    const cfg = (v ?? {}) as {
                        SubnetIds?: unknown[];
                        SecurityGroupIds?: unknown[];
                    };
                    const subnetIds = cfg.SubnetIds ?? [];
                    const sgIds = cfg.SecurityGroupIds ?? [];
                    const subnets = subnetIds
                        .map(
                            (id, i) =>
                                `ec2.Subnet.fromSubnetId(this, 'Subnet${i}', ${valueToTs(id)})`
                        )
                        .join(', ');
                    const sgs = sgIds
                        .map(
                            (id, i) =>
                                `ec2.SecurityGroup.fromSecurityGroupId(this, 'SecurityGroup${i}', ${valueToTs(id)})`
                        )
                        .join(', ');
                    return {
                        vpc: new RawTs(
                            `ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: '' /* TODO: [IMPORTANT] replace with actual VPC ID */ })`
                        ),
                        vpcSubnets: new RawTs(`{ subnets: [${subnets}] }`),
                        securityGroups: new RawTs(`[${sgs}]`),
                    };
                },
            ],
        ]),
    },
    'AWS::Lambda::EventSourceMapping': {
        cdkModule: 'aws-cdk-lib/aws-lambda',
        importAlias: 'lambda',
        className: 'EventSourceMapping',
        cfnNameProp: '',
        omitProps: new Set(),
        propExpansions: new Map([
            [
                'FunctionName',
                v => ({
                    target: new RawTs(
                        `lambda.Function.fromFunctionName(this, 'Target', ${valueToTs(v)})`
                    ),
                }),
            ],
        ]),
    },
    'AWS::Lambda::LayerVersion': {
        cdkModule: 'aws-cdk-lib/aws-lambda',
        importAlias: 'lambda',
        className: 'LayerVersion',
        cfnNameProp: 'LayerName',
        omitProps: new Set(),
        propExpansions: new Map([
            [
                'Content',
                v => {
                    const content = (v ?? {}) as {
                        S3Bucket?: unknown;
                        S3Key?: unknown;
                        S3ObjectVersion?: unknown;
                    };
                    if (content.S3Bucket && content.S3Key) {
                        const bucket = `s3.Bucket.fromBucketName(this, 'ContentBucket', ${valueToTs(content.S3Bucket)})`;
                        const objectVersion = content.S3ObjectVersion
                            ? `, ${valueToTs(content.S3ObjectVersion)}`
                            : '';
                        return {
                            code: new RawTs(
                                `lambda.Code.fromBucket(${bucket}, ${valueToTs(content.S3Key)}${objectVersion})`
                            ),
                        };
                    }
                    return {
                        code: new RawTs(`lambda.Code.fromAsset('TODO: specify layer code path')`),
                    };
                },
            ],
        ]),
    },

    // DynamoDB
    'AWS::DynamoDB::Table': {
        cdkModule: 'aws-cdk-lib/aws-dynamodb',
        importAlias: 'dynamodb',
        className: 'Table',
        cfnNameProp: 'TableName',
        omitProps: new Set(),
        propExpansions: new Map([
            [
                'AttributeDefinitions',
                (attrDefs, allProps) => {
                    // Build a lookup from attribute name to DynamoDB type (S/N/B)
                    const defs = (attrDefs ?? []) as Array<{
                        AttributeName: string;
                        AttributeType: string;
                    }>;
                    const typeMap = new Map(defs.map(d => [d.AttributeName, d.AttributeType]));

                    // KeySchema identifies HASH (partition) and RANGE (sort) keys
                    const keySchema = (allProps['KeySchema'] ?? []) as Array<{
                        AttributeName: string;
                        KeyType: 'HASH' | 'RANGE';
                    }>;
                    delete allProps['KeySchema'];

                    const result: Record<string, unknown> = {};
                    for (const key of keySchema) {
                        const attrType = typeMap.get(key.AttributeName) ?? 'S';
                        const cdkAttrType =
                            attrType === 'N' ? 'NUMBER' : attrType === 'B' ? 'BINARY' : 'STRING';
                        const cdkType = new RawTs(`dynamodb.AttributeType.${cdkAttrType}`);
                        const prop = key.KeyType === 'HASH' ? 'partitionKey' : 'sortKey';
                        result[prop] = { name: key.AttributeName, type: cdkType };
                    }
                    return result;
                },
            ],
        ]),
    },

    // S3
    'AWS::S3::Bucket': {
        cdkModule: 'aws-cdk-lib/aws-s3',
        importAlias: 's3',
        className: 'Bucket',
        cfnNameProp: 'BucketName',
        omitProps: new Set(),
    },

    'AWS::StepFunctions::StateMachine': {
        cdkModule: '@aligent/cdk-step-function-from-file',
        importAlias: 'sfnFromFile',
        className: 'StepFunctionFromFile',
        cfnNameProp: 'StateMachineName',
        omitProps: new Set(['DefinitionString', 'LoggingConfiguration', 'RoleArn']),
        propExpansions: new Map<string, (v: unknown) => Record<string, unknown>>([
            [
                'StateMachineType',
                v => ({
                    stateMachineType:
                        typeof v === 'string' ? new RawTs(`sfn.StateMachineType.${v}`) : v,
                }),
            ],
            [
                'TracingConfiguration',
                v => ({
                    tracingEnabled: (v as Record<string, unknown>)?.['Enabled'],
                }),
            ],
        ]),
    },

    // API Gateway
    'AWS::ApiGateway::RestApi': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        className: 'RestApi',
        cfnNameProp: 'Name',
        omitProps: new Set(),
    },
    'AWS::ApiGateway::ApiKey': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        className: 'ApiKey',
        cfnNameProp: 'Name',
        // StageKeys is deprecated in favour of UsagePlan.stages
        omitProps: new Set(['StageKeys']),
    },
    'AWS::ApiGateway::UsagePlan': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        className: 'UsagePlan',
        cfnNameProp: 'UsagePlanName',
        // ApiStages references IRestApi/Stage constructs — add via addApiStage() after construction
        omitProps: new Set(['ApiStages']),
    },

    // IAM
    // 'AWS::IAM::Role': {
    //     cdkModule: 'aws-cdk-lib/aws-iam',
    //     importAlias: 'iam',
    //     className: 'Role',
    //     cfnNameProp: 'RoleName',
    //     omitProps: new Set(),
    // },
    // 'AWS::IAM::Policy': {
    //     cdkModule: 'aws-cdk-lib/aws-iam',
    //     importAlias: 'iam',
    //     className: 'Policy',
    //     cfnNameProp: 'PolicyName',
    //     omitProps: new Set(),
    // },

    // Logs
    // 'AWS::Logs::LogGroup': {
    //     cdkModule: 'aws-cdk-lib/aws-logs',
    //     importAlias: 'logs',
    //     className: 'LogGroup',
    //     cfnNameProp: 'LogGroupName',
    //     omitProps: new Set(),
    // },

    // Step Functions

    // SQS
    'AWS::SQS::Queue': {
        cdkModule: 'aws-cdk-lib/aws-sqs',
        importAlias: 'sqs',
        className: 'Queue',
        cfnNameProp: 'QueueName',
        omitProps: new Set(),
    },

    // SNS
    'AWS::SNS::Topic': {
        cdkModule: 'aws-cdk-lib/aws-sns',
        importAlias: 'sns',
        className: 'Topic',
        cfnNameProp: 'TopicName',
        // Subscriptions are added via topic.addSubscription() — they should be separate AWS::SNS::Subscription resources
        omitProps: new Set(['Subscription']),
    },
    'AWS::SNS::Subscription': {
        cdkModule: 'aws-cdk-lib/aws-sns',
        importAlias: 'sns',
        className: 'Subscription',
        cfnNameProp: '',
        // RedrivePolicy is replaced by deadLetterQueue: IQueue construct reference in L2
        omitProps: new Set(['RedrivePolicy']),
        propExpansions: new Map([
            [
                'TopicArn',
                v => ({
                    topic: new RawTs(`sns.Topic.fromTopicArn(this, 'Topic', ${valueToTs(v)})`),
                }),
            ],
        ]),
    },

    // Events
    'AWS::Events::Rule': {
        cdkModule: 'aws-cdk-lib/aws-events',
        importAlias: 'events',
        className: 'Rule',
        cfnNameProp: 'Name',
        // Targets require IRuleTarget instances (e.g. LambdaFunction, SfnStateMachine) — add via rule.addTarget()
        omitProps: new Set(['Targets']),
    },

    // CloudWatch
    'AWS::CloudWatch::Alarm': {
        cdkModule: 'aws-cdk-lib/aws-cloudwatch',
        importAlias: 'cw',
        className: 'Alarm',
        cfnNameProp: 'AlarmName',
        omitProps: new Set(),
    },

    // SSM
    'AWS::SSM::Parameter': {
        cdkModule: 'aws-cdk-lib/aws-ssm',
        importAlias: 'ssm',
        className: 'StringParameter',
        cfnNameProp: 'Name',
        omitProps: new Set(),
    },

    // Secrets Manager
    'AWS::SecretsManager::Secret': {
        cdkModule: 'aws-cdk-lib/aws-secretsmanager',
        importAlias: 'secretsmanager',
        className: 'Secret',
        cfnNameProp: 'Name',
        omitProps: new Set(),
    },
};
