import type { CdkMapping } from '../types/index.js';
import { detectIntrinsic, generateCdkId, pascalToCamel, RawTs, valueToTs } from './cfn-to-ts.js';

interface Integration {
    Type?: string;
    Uri?: unknown;
    RequestTemplates?: Record<string, unknown>;
}

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
 * Resolves a CloudFormation `Fn::GetAtt`/`Ref` parent reference to the CDK variable expression.
 * - `Fn::GetAtt: [RestApiId, RootResourceId]` → `restApiVar.root`
 * - `Ref: ResourceLogicalId` → `resourceVar`
 */
function resolveParentExpr(v: unknown): string {
    const intrinsic = detectIntrinsic(v);
    if (intrinsic?.fn === 'Fn::GetAtt') {
        const [logicalId] = intrinsic.arg as [string, string];
        return `${pascalToCamel(generateCdkId(logicalId))}.root`;
    }
    if (intrinsic?.fn === 'Ref') {
        const logicalId = intrinsic.arg as string;
        return pascalToCamel(generateCdkId(logicalId));
    }
    return `/* TODO: resolve parent reference */`;
}

/** Extracts the template string from a `Fn::Sub` value (string or [template, vars] form). */
function getSubTemplate(value: unknown): string | null {
    const intrinsic = detectIntrinsic(value);
    if (intrinsic?.fn !== 'Fn::Sub') return null;
    return typeof intrinsic.arg === 'string'
        ? intrinsic.arg
        : Array.isArray(intrinsic.arg)
          ? (intrinsic.arg as [string])[0]
          : null;
}

/**
 * Attempts to extract the Lambda logical ID from a Lambda proxy integration URI.
 * Handles the common Serverless Framework pattern:
 *   `Fn::Sub: arn:...:functions/${MyFunctionLambdaFunction.Arn}/invocations`
 */
function resolveLambdaLogicalIdFromUri(uri: unknown): string | null {
    const template = getSubTemplate(uri);
    if (!template) return null;
    return /functions\/\$\{([^.}]+)\.Arn\}/.exec(template)?.[1] ?? null;
}

/**
 * Attempts to extract the SQS queue logical ID from an AWS integration URI.
 * Handles: `Fn::Sub: arn:...:sqs:path/${AWS::AccountId}/${MyQueue.QueueName}`
 * Also matches bare Ref form: `.../${MyQueue}`
 */
function resolveSqsQueueLogicalIdFromUri(uri: unknown): string | null {
    const template = getSubTemplate(uri);
    if (!template) return null;
    return /sqs:path\/[^/]+\/\$\{([^.}]+)(?:\.QueueName)?\}/.exec(template)?.[1] ?? null;
}

/**
 * Attempts to extract the Step Functions state machine logical ID from a CFN Integration's
 * RequestTemplates. Looks for `"stateMachineArn": "${LogicalId}"` in any Fn::Sub template.
 */
function resolveSfnLogicalIdFromRequestTemplates(
    requestTemplates: Record<string, unknown> | undefined
): string | null {
    if (!requestTemplates) return null;
    for (const tpl of Object.values(requestTemplates)) {
        const text = getSubTemplate(tpl) ?? (typeof tpl === 'string' ? tpl : null);
        if (!text) continue;
        const match = /"stateMachineArn"\s*:\s*"\$\{([^.}]+)(?:\.Arn)?\}"/.exec(text);
        if (match?.[1]) return match[1];
    }
    return null;
}

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
                                `ec2.Subnet.fromSubnetId(scope, 'Subnet${i}', ${valueToTs(id)})`
                        )
                        .join(', ');
                    const sgs = sgIds
                        .map(
                            (id, i) =>
                                `ec2.SecurityGroup.fromSecurityGroupId(scope, 'SecurityGroup${i}', ${valueToTs(id)})`
                        )
                        .join(', ');
                    return {
                        vpc: new RawTs(
                            `ec2.Vpc.fromLookup(scope, 'Vpc', { vpcId: '' /* TODO: [IMPORTANT] replace with actual VPC ID */ })`
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
        propExpansions: new Map([
            [
                'LifecycleConfiguration',
                v => {
                    const cfg = (v ?? {}) as { Rules?: Array<Record<string, unknown>> };
                    const rules = (cfg.Rules ?? []).map(rule => {
                        const cdkRule: Record<string, unknown> = {};
                        if ('Status' in rule) {
                            cdkRule['enabled'] = rule['Status'] === 'Enabled';
                        }
                        if (typeof rule['ExpirationInDays'] === 'number') {
                            cdkRule['expiration'] = new RawTs(
                                `cdk.Duration.days(${rule['ExpirationInDays']})`
                            );
                        }
                        if (typeof rule['ExpirationDate'] === 'string') {
                            cdkRule['expirationDate'] = new RawTs(
                                `new Date('${rule['ExpirationDate']}')`
                            );
                        }
                        if (typeof rule['NoncurrentVersionExpiration'] === 'object') {
                            const nve = rule['NoncurrentVersionExpiration'] as Record<
                                string,
                                unknown
                            >;
                            if (typeof nve['NoncurrentDays'] === 'number') {
                                cdkRule['noncurrentVersionExpiration'] = new RawTs(
                                    `cdk.Duration.days(${nve['NoncurrentDays']})`
                                );
                            }
                        }
                        return cdkRule;
                    });
                    return { lifecycleRules: rules };
                },
            ],
        ]),
    },

    // Step Functions
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
    'AWS::ApiGateway::Resource': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        // Not instantiated with `new` — generated via parent.addResource(pathPart)
        className: 'Resource',
        cfnNameProp: '',
        omitProps: new Set(['RestApiId']),
        propExpansions: new Map<string, (v: unknown) => Record<string, unknown>>([
            ['ParentId', v => ({ parentRef: new RawTs(resolveParentExpr(v)) })],
        ]),
    },
    'AWS::ApiGateway::Method': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        // Not instantiated with `new` — generated via resource.addMethod(httpMethod, integration, options)
        className: 'Method',
        cfnNameProp: '',
        // AuthorizerId requires an IAuthorizer construct ref; MethodResponses is complex to map
        omitProps: new Set(['RestApiId', 'AuthorizerId', 'MethodResponses']),
        propExpansions: new Map<string, (v: unknown) => Record<string, unknown>>([
            ['ResourceId', v => ({ resourceRef: new RawTs(resolveParentExpr(v)) })],
            [
                'AuthorizationType',
                v => ({ authorizationType: new RawTs(`apigw.AuthorizationType.${v}`) }),
            ],
            [
                'Integration',
                v => {
                    const integration = (v ?? {}) as Integration;

                    if (integration.Type === 'AWS_PROXY' && integration.Uri) {
                        const lambdaId = resolveLambdaLogicalIdFromUri(integration.Uri);
                        if (lambdaId) {
                            const varName = pascalToCamel(generateCdkId(lambdaId));
                            return {
                                integrationRef: new RawTs(
                                    `new apigw.LambdaIntegration(${varName})`
                                ),
                            };
                        }
                    }

                    if (integration.Type === 'AWS' && integration.Uri) {
                        const uriTemplate = getSubTemplate(integration.Uri) ?? '';
                        if (uriTemplate.includes(':sqs:')) {
                            const queueId = resolveSqsQueueLogicalIdFromUri(integration.Uri);
                            if (queueId) {
                                const queueVar = pascalToCamel(generateCdkId(queueId));
                                return {
                                    integrationRef: new RawTs(
                                        `new apigw.AwsIntegration({ service: 'sqs', path: \`\${cdk.Aws.ACCOUNT_ID}/\${${queueVar}.queueName}\`, integrationHttpMethod: 'POST' })`
                                    ),
                                };
                            }
                            return {
                                integrationRef: new RawTs(
                                    `/* TODO: SQS AwsIntegration — set service: 'sqs', path, and options */`
                                ),
                            };
                        }
                        if (uriTemplate.includes(':states:action/StartExecution')) {
                            const sfnId = resolveSfnLogicalIdFromRequestTemplates(
                                integration.RequestTemplates
                            );
                            if (sfnId) {
                                const sfnVar = pascalToCamel(generateCdkId(sfnId));
                                return {
                                    integrationRef: new RawTs(
                                        `apigw.StepFunctionsIntegration.startExecution(${sfnVar})`
                                    ),
                                };
                            }
                            return {
                                integrationRef: new RawTs(
                                    `/* TODO: Step Functions integration — use apigw.StepFunctionsIntegration.startExecution(stateMachine) */`
                                ),
                            };
                        }
                    }

                    if (integration.Type === 'MOCK') {
                        return { integrationRef: new RawTs(`new apigw.MockIntegration()`) };
                    }

                    return {
                        integrationRef: new RawTs(
                            `/* TODO: ${integration.Type ?? 'unknown'} integration */`
                        ),
                    };
                },
            ],
        ]),
    },
    'AWS::ApiGateway::RestApi': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        className: 'RestApi',
        cfnNameProp: 'Name',
        // Policy requires a PolicyDocument object — provide via iam.PolicyDocument.fromJson() if needed
        omitProps: new Set(['Policy']),
        propExpansions: new Map<string, (v: unknown) => Record<string, unknown>>([
            [
                'EndpointConfiguration',
                v => {
                    const cfg = (v ?? {}) as { Types?: string[] };
                    const types = (cfg.Types ?? []).map(t => new RawTs(`apigw.EndpointType.${t}`));
                    return { endpointConfiguration: { types } };
                },
            ],
            ['Name', v => ({ restApiName: v })],
        ]),
    },
    'AWS::ApiGateway::ApiKey': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        className: 'ApiKey',
        cfnNameProp: 'Name',
        // StageKeys is deprecated in favour of UsagePlan.stages
        omitProps: new Set(['StageKeys']),
        propExpansions: new Map([['Name', v => ({ apiKeyName: v })]]),
    },
    'AWS::ApiGateway::UsagePlan': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        className: 'UsagePlan',
        cfnNameProp: 'UsagePlanName',
        // ApiStages references IRestApi/Stage constructs — add via addApiStage() after construction
        omitProps: new Set(['ApiStages']),
        propExpansions: new Map([['UsagePlanName', v => ({ name: v })]]),
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
        propExpansions: new Map<string, (v: unknown) => Record<string, unknown>>([
            [
                'ScheduleExpression',
                v => ({
                    schedule: new RawTs(`events.Schedule.expression(${valueToTs(v)})`),
                }),
            ],
            ['State', v => ({ enabled: v === 'ENABLED' })],
        ]),
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
