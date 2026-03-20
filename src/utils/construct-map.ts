import type { CdkMapping } from '../types/index.js';
import { RawTs } from './cfn-to-ts.js';

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
        omitProps: new Set(['Code', 'Handler', 'Runtime', 'Role']),
        propTransforms: new Map([
            ['Timeout', v => (typeof v === 'number' ? new RawTs(`cdk.Duration.seconds(${v})`) : v)],
            [
                'Environment',
                v =>
                    v && typeof v === 'object' && 'Variables' in (v as Record<string, unknown>)
                        ? (v as Record<string, unknown>)['Variables']
                        : v,
            ],
        ]),
    },
    'AWS::Lambda::EventSourceMapping': {
        cdkModule: 'aws-cdk-lib/aws-lambda',
        importAlias: 'lambda',
        className: 'EventSourceMapping',
        cfnNameProp: '',
        omitProps: new Set(),
    },
    'AWS::Lambda::LayerVersion': {
        cdkModule: 'aws-cdk-lib/aws-lambda',
        importAlias: 'lambda',
        className: 'LayerVersion',
        cfnNameProp: 'LayerName',
        omitProps: new Set(),
    },

    // DynamoDB
    'AWS::DynamoDB::Table': {
        cdkModule: 'aws-cdk-lib/aws-dynamodb',
        importAlias: 'dynamodb',
        className: 'Table',
        cfnNameProp: 'TableName',
        omitProps: new Set(),
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
        propTransforms: new Map([
            [
                'StateMachineType',
                v => (typeof v === 'string' ? new RawTs(`sfn.StateMachineType.${v}`) : v),
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
    // TODO: ApiKey, UsagePlan

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
        omitProps: new Set(),
    },
    'AWS::SNS::Subscription': {
        cdkModule: 'aws-cdk-lib/aws-sns-subscriptions',
        importAlias: 'snsSubscriptions',
        className: 'Subscription',
        cfnNameProp: '',
        omitProps: new Set(),
    },

    // Events
    'AWS::Events::Rule': {
        cdkModule: 'aws-cdk-lib/aws-events',
        importAlias: 'events',
        className: 'Rule',
        cfnNameProp: 'Name',
        omitProps: new Set(),
    },
    // TODO: className: 'Schedule'

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
