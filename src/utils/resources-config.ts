import type { CdkMapping } from '../types/index.js';
import {
    detectIntrinsic,
    generateCdkId,
    pascalToCamel,
    RawTs,
    resolveLogicalId,
    valueToTs,
} from './cfn-to-ts.js';

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
 * Maps CloudFormation resource type + GetAtt attribute name to the equivalent
 * CDK L2 construct property accessor.
 */
const CFN_GETATT_TO_CDK_PROP: Record<string, Record<string, string>> = {
    // Lambda
    'AWS::Lambda::Function': {
        Arn: 'functionArn',
        FunctionName: 'functionName',
    },
    // DynamoDB
    'AWS::DynamoDB::Table': {
        Arn: 'tableArn',
        StreamArn: 'tableStreamArn',
    },
    // S3
    'AWS::S3::Bucket': {
        Arn: 'bucketArn',
        DomainName: 'bucketDomainName',
        DualStackDomainName: 'bucketDualStackDomainName',
        RegionalDomainName: 'bucketRegionalDomainName',
        WebsiteURL: 'bucketWebsiteUrl',
    },
    // Step Functions
    'AWS::StepFunctions::StateMachine': {
        Arn: 'stateMachineArn',
        Name: 'stateMachineName',
    },
    // SQS
    'AWS::SQS::Queue': {
        Arn: 'queueArn',
        QueueName: 'queueName',
        QueueUrl: 'queueUrl',
    },
    // SNS
    'AWS::SNS::Topic': {
        TopicArn: 'topicArn',
        TopicName: 'topicName',
    },
    // Events
    'AWS::Events::EventBus': {
        Arn: 'eventBusArn',
        Name: 'eventBusName',
    },
    'AWS::Events::Rule': {
        Arn: 'ruleArn',
    },
    // Scheduler
    'AWS::Scheduler::ScheduleGroup': {
        Arn: 'scheduleGroupArn',
    },
    // CloudWatch
    'AWS::CloudWatch::Alarm': {
        Arn: 'alarmArn',
        AlarmName: 'alarmName',
    },
    // Secrets Manager
    'AWS::SecretsManager::Secret': {
        Id: 'secretArn',
    },
};

export const CFN_TYPE_ORDER: Record<string, number> = {
    'AWS::SNS::Topic': 10,
    'AWS::SNS::Subscription': 11,

    'AWS::ApiGateway::RestApi': 20,
    'AWS::ApiGateway::ApiKey': 21,
    'AWS::ApiGateway::RequestValidator': 22,
    'AWS::ApiGateway::Resource': 23,
    'AWS::ApiGateway::Method': 24,
    'AWS::ApiGateway::UsagePlan': 25,

    'AWS::CloudWatch::Alarm': 30,
};

/**
 * Resolves a CloudFormation `Fn::GetAtt`/`Ref` parent reference to the CDK variable expression.
 * - `Fn::GetAtt: [RestApiId, RootResourceId]` → `restApiVar.root`
 * - `Ref: ResourceLogicalId` → `resourceVar`
 */
function resolveParentExpr(ref: unknown, servicePrefix: string): string {
    const intrinsic = detectIntrinsic(ref);
    const logicalId = resolveLogicalId(intrinsic);
    if (!logicalId) return `/* TODO: resolve parent reference */`;
    const varName = pascalToCamel(generateCdkId(logicalId, servicePrefix));
    return intrinsic!.fn === 'Fn::GetAtt' ? `${varName}.root` : varName;
}

/**
 * Converts a single `Fn::Join` part to a `Fn::Sub`-style string fragment.
 * - Plain strings are returned as-is.
 * - `{"Ref": "Id"}` → `${Id}`
 * - `{"Fn::GetAtt": ["Id", "Attr"]}` → `${Id.Attr}`
 */
function joinPartToSubFragment(part: unknown): string {
    if (typeof part === 'string') return part;
    const intrinsic = detectIntrinsic(part);
    const logicalId = resolveLogicalId(intrinsic);
    if (!logicalId) return '';
    if (intrinsic!.fn === 'Fn::GetAtt') {
        const [, attr] = intrinsic!.arg as [string, string];
        return `\${${logicalId}.${attr}}`;
    }
    return `\${${logicalId}}`;
}

/**
 * Extracts a `Fn::Sub`-style template string from either a `Fn::Sub` or `Fn::Join` value.
 * - `Fn::Sub: "template"` → `"template"`
 * - `Fn::Sub: ["template", vars]` → `"template"`
 * - `Fn::Join: ["", [...parts]]` → parts joined as a Sub-style template string
 */
function getSubTemplate(value: unknown): string | null {
    const intrinsic = detectIntrinsic(value);
    if (!intrinsic) return null;

    if (intrinsic.fn === 'Fn::Sub') {
        return typeof intrinsic.arg === 'string'
            ? intrinsic.arg
            : Array.isArray(intrinsic.arg)
              ? (intrinsic.arg as [string])[0]
              : null;
    }

    if (intrinsic.fn === 'Fn::Join' && Array.isArray(intrinsic.arg)) {
        const [delimiter, parts] = intrinsic.arg as [string, unknown[]];
        if (!Array.isArray(parts)) return null;
        return parts.map(joinPartToSubFragment).join(delimiter);
    }

    return null;
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
            (
                v: unknown,
                allProps: Record<string, unknown>,
                resourceTypes: Record<string, string>,
                servicePrefix: string
            ) => Record<string, unknown>
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
                (v, _allProps, _resourceTypes, servicePrefix) => {
                    const cfg = (v ?? {}) as {
                        SubnetIds?: unknown[];
                        SecurityGroupIds?: unknown[];
                    };
                    const subnetIds = cfg.SubnetIds ?? [];
                    const sgIds = cfg.SecurityGroupIds ?? [];
                    const subnets = subnetIds
                        .map(
                            (id, i) =>
                                `ec2.Subnet.fromSubnetId(scope, 'Subnet${i}', ${valueToTs(id, servicePrefix)})`
                        )
                        .join(', ');
                    const sgs = sgIds
                        .map(
                            (id, i) =>
                                `ec2.SecurityGroup.fromSecurityGroupId(scope, 'SecurityGroup${i}', ${valueToTs(id, servicePrefix)})`
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
                (v, _allProps, _resourceTypes, servicePrefix) => ({
                    target: new RawTs(
                        `lambda.Function.fromFunctionName(this, 'Target', ${valueToTs(v, servicePrefix)})`
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
                (v, _allProps, _resourceTypes, servicePrefix) => {
                    const content = (v ?? {}) as {
                        S3Bucket?: unknown;
                        S3Key?: unknown;
                        S3ObjectVersion?: unknown;
                    };
                    if (content.S3Bucket && content.S3Key) {
                        const bucket = `s3.Bucket.fromBucketName(this, 'ContentBucket', ${valueToTs(content.S3Bucket, servicePrefix)})`;
                        const objectVersion = content.S3ObjectVersion
                            ? `, ${valueToTs(content.S3ObjectVersion, servicePrefix)}`
                            : '';
                        return {
                            code: new RawTs(
                                `lambda.Code.fromBucket(${bucket}, ${valueToTs(content.S3Key, servicePrefix)}${objectVersion})`
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
        omitProps: new Set(['BillingMode', 'ProvisionedThroughput']),
        propExpansions: new Map([
            [
                'TimeToLiveSpecification',
                v => {
                    const spec = (v ?? {}) as { AttributeName?: string; Enabled?: boolean };
                    if (spec.Enabled && spec.AttributeName) {
                        return { timeToLiveAttribute: spec.AttributeName };
                    }
                    return {};
                },
            ],
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
    'AWS::ApiGateway::RequestValidator': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        className: 'RequestValidator',
        cfnNameProp: '',
        omitProps: new Set(),
        propExpansions: new Map([
            [
                'RestApiId',
                (v, _allProps, _resourceTypes, servicePrefix): Record<string, unknown> => ({
                    restApi: new RawTs(`${resolveParentExpr(v, servicePrefix)} as apigw.IRestApi`),
                }),
            ],
            ['Name', v => ({ requestValidatorName: v })],
        ]),
    },
    'AWS::ApiGateway::Resource': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        // Not instantiated with `new` — generated via parent.addResource(pathPart)
        className: 'Resource',
        cfnNameProp: '',
        omitProps: new Set(['RestApiId']),
        propExpansions: new Map([
            [
                'ParentId',
                (v, _allProps, _resourceTypes, servicePrefix) => ({
                    parentRef: new RawTs(resolveParentExpr(v, servicePrefix)),
                }),
            ],
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
        propExpansions: new Map([
            [
                'ResourceId',
                (v, _allProps, _resourceTypes, servicePrefix): Record<string, unknown> => ({
                    resourceRef: new RawTs(resolveParentExpr(v, servicePrefix)),
                }),
            ],
            [
                'RequestValidatorId',
                (v, _allProps, _resourceTypes, servicePrefix) => ({
                    requestValidator: new RawTs(resolveParentExpr(v, servicePrefix)),
                }),
            ],
            [
                'AuthorizationType',
                v => ({ authorizationType: new RawTs(`apigw.AuthorizationType.${v}`) }),
            ],
            [
                'Integration',
                (v, _allProps, _resourceTypes, servicePrefix) => {
                    const integration = (v ?? {}) as Integration;

                    if (integration.Type === 'AWS_PROXY' && integration.Uri) {
                        const lambdaId = resolveLambdaLogicalIdFromUri(integration.Uri);
                        if (lambdaId) {
                            const varName = pascalToCamel(generateCdkId(lambdaId, servicePrefix));
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
                                const queueVar = pascalToCamel(
                                    generateCdkId(queueId, servicePrefix)
                                );
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
                                const sfnVar = pascalToCamel(generateCdkId(sfnId, servicePrefix));
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

    // SQS
    'AWS::SQS::Queue': {
        cdkModule: 'aws-cdk-lib/aws-sqs',
        importAlias: 'sqs',
        className: 'Queue',
        cfnNameProp: 'QueueName',
        omitProps: new Set(),
        propExpansions: new Map<
            string,
            (
                v: unknown,
                allProps: Record<string, unknown>,
                resourceTypes: Record<string, string>,
                servicePrefix: string
            ) => Record<string, unknown>
        >([
            [
                'VisibilityTimeout',
                v => ({
                    visibilityTimeout:
                        typeof v === 'number' ? new RawTs(`cdk.Duration.seconds(${v})`) : v,
                }),
            ],
            ['FifoQueue', v => ({ fifo: v })],
            [
                'MessageRetentionPeriod',
                v => ({
                    retentionPeriod:
                        typeof v === 'number' ? new RawTs(`cdk.Duration.seconds(${v})`) : v,
                }),
            ],
            [
                'ReceiveMessageWaitTimeSeconds',
                v => ({
                    receiveMessageWaitTime:
                        typeof v === 'number' ? new RawTs(`cdk.Duration.seconds(${v})`) : v,
                }),
            ],
            [
                'DelaySeconds',
                v => ({
                    deliveryDelay:
                        typeof v === 'number' ? new RawTs(`cdk.Duration.seconds(${v})`) : v,
                }),
            ],
            [
                'RedrivePolicy',
                (v, _allProps, _resourceTypes, servicePrefix) => {
                    const policy = (v ?? {}) as {
                        deadLetterTargetArn?: unknown;
                        maxReceiveCount?: unknown;
                    };
                    const intrinsic = detectIntrinsic(policy.deadLetterTargetArn);
                    const dlqLogicalId = resolveLogicalId(intrinsic);
                    const dlqVar = dlqLogicalId
                        ? pascalToCamel(generateCdkId(dlqLogicalId, servicePrefix))
                        : `/* TODO: resolve dead-letter queue */`;
                    const maxReceiveCount = policy.maxReceiveCount ?? 3;
                    return {
                        deadLetterQueue: new RawTs(
                            `{ queue: ${dlqVar}, maxReceiveCount: ${maxReceiveCount} }`
                        ),
                    };
                },
            ],
            ['ContentBasedDeduplication', v => ({ contentBasedDeduplication: v })],
        ]),
    },

    // SNS
    'AWS::SNS::Topic': {
        cdkModule: 'aws-cdk-lib/aws-sns',
        importAlias: 'sns',
        className: 'Topic',
        cfnNameProp: 'TopicName',
        // Subscriptions are added via topic.addSubscription() — they should be separate AWS::SNS::Subscription resources
        omitProps: new Set(['Subscription', 'KmsMasterKeyId']),
    },
    'AWS::SNS::Subscription': {
        cdkModule: 'aws-cdk-lib/aws-sns',
        importAlias: 'sns',
        className: 'Subscription',
        cfnNameProp: '',
        omitProps: new Set(),
        propExpansions: new Map<
            string,
            (
                v: unknown,
                allProps: Record<string, unknown>,
                resourceTypes: Record<string, string>,
                servicePrefix: string
            ) => Record<string, unknown>
        >([
            [
                'RedrivePolicy',
                (v, _allProps, _resourceTypes, servicePrefix) => {
                    const policy = (v ?? {}) as { deadLetterTargetArn?: unknown };
                    const intrinsic = detectIntrinsic(policy.deadLetterTargetArn);
                    const dlqLogicalId = resolveLogicalId(intrinsic);
                    const dlqVar = dlqLogicalId
                        ? pascalToCamel(generateCdkId(dlqLogicalId, servicePrefix))
                        : `/* TODO: resolve dead-letter queue */`;
                    return { deadLetterQueue: new RawTs(dlqVar) };
                },
            ],
            [
                'TopicArn',
                (v, _allProps, _resourceTypes, servicePrefix) => {
                    const intrinsic = detectIntrinsic(v);
                    const topicLogicalId = resolveLogicalId(intrinsic);
                    const topicVar = topicLogicalId
                        ? pascalToCamel(generateCdkId(topicLogicalId, servicePrefix))
                        : `sns.Topic.fromTopicArn(this, 'Topic', ${valueToTs(v, servicePrefix)})`;
                    return { topic: new RawTs(topicVar) };
                },
            ],
            [
                'Protocol',
                v => ({
                    protocol:
                        typeof v === 'string'
                            ? new RawTs(`sns.SubscriptionProtocol.${v.toUpperCase()}`)
                            : v,
                }),
            ],
            [
                'Endpoint',
                (v, _allProps, resourceTypes, servicePrefix) => {
                    const intrinsic = detectIntrinsic(v);
                    const logicalId = resolveLogicalId(intrinsic);
                    if (!logicalId) return { endpoint: new RawTs(valueToTs(v, servicePrefix)) };
                    const varName = pascalToCamel(generateCdkId(logicalId, servicePrefix));
                    if (intrinsic!.fn === 'Fn::GetAtt') {
                        const [, attribute] = intrinsic!.arg as [string, string];
                        const cfnType = resourceTypes[logicalId];
                        const cdkProp = cfnType
                            ? CFN_GETATT_TO_CDK_PROP[cfnType]?.[attribute]
                            : undefined;
                        const accessor = cdkProp ?? `attr${attribute}`;
                        return { endpoint: new RawTs(`${varName}.${accessor}`) };
                    }
                    return { endpoint: new RawTs(varName) };
                },
            ],
            [
                'FilterPolicy',
                (v, _allProps, _resourceTypes, servicePrefix) => {
                    const policy = (v ?? {}) as Record<string, unknown>;
                    const filterMap: Record<string, unknown> = {};
                    for (const [attr, conditions] of Object.entries(policy)) {
                        if (
                            Array.isArray(conditions) &&
                            conditions.every(c => typeof c === 'string')
                        ) {
                            const allowlist = conditions
                                .map(c => valueToTs(c, servicePrefix))
                                .join(', ');
                            filterMap[attr] = new RawTs(
                                `sns.SubscriptionFilter.stringFilter({ allowlist: [${allowlist}] })`
                            );
                        } else {
                            filterMap[attr] = new RawTs(
                                `sns.SubscriptionFilter.stringFilter(/* TODO: convert filter conditions ${valueToTs(conditions, servicePrefix)} */)`
                            );
                        }
                    }
                    return { filterPolicy: filterMap };
                },
            ],
        ]),
    },

    // Events
    'AWS::Events::EventBus': {
        cdkModule: 'aws-cdk-lib/aws-events',
        importAlias: 'events',
        className: 'EventBus',
        cfnNameProp: 'Name',
        omitProps: new Set(),
        propExpansions: new Map([['Name', v => ({ eventBusName: v })]]),
    },
    'AWS::Events::Rule': {
        cdkModule: 'aws-cdk-lib/aws-events',
        importAlias: 'events',
        className: 'Rule',
        cfnNameProp: 'Name',
        omitProps: new Set(),
        propExpansions: new Map<
            string,
            (
                v: unknown,
                allProps: Record<string, unknown>,
                resourceTypes: Record<string, string>,
                servicePrefix: string
            ) => Record<string, unknown>
        >([
            [
                'ScheduleExpression',
                (v, _allProps, _resourceTypes, servicePrefix) => ({
                    schedule: new RawTs(
                        `events.Schedule.expression(${valueToTs(v, servicePrefix)})`
                    ),
                }),
            ],
            ['State', v => ({ enabled: v === 'ENABLED' })],
        ]),
    },

    // Scheduler
    'AWS::Scheduler::ScheduleGroup': {
        cdkModule: 'aws-cdk-lib/aws-scheduler',
        importAlias: 'scheduler',
        className: 'ScheduleGroup',
        cfnNameProp: 'Name',
        omitProps: new Set(),
        propExpansions: new Map([['Name', v => ({ scheduleGroupName: v })]]),
    },

    // CloudWatch
    'AWS::CloudWatch::Alarm': {
        cdkModule: 'aws-cdk-lib/aws-cloudwatch',
        importAlias: 'cw',
        className: 'Alarm',
        cfnNameProp: 'AlarmName',
        omitProps: new Set(),
        propExpansions: new Map<
            string,
            (
                v: unknown,
                allProps: Record<string, unknown>,
                resourceTypes: Record<string, string>,
                servicePrefix: string
            ) => Record<string, unknown>
        >([
            [
                'Dimensions',
                (v, _allProps, resourceTypes, servicePrefix) => {
                    const dims = (v ?? []) as Array<{ Name: string; Value: unknown }>;
                    const map: Record<string, unknown> = {};
                    for (const d of dims) {
                        const intrinsic = detectIntrinsic(d.Value);
                        const logicalId = resolveLogicalId(intrinsic);

                        map[d.Name] =
                            logicalId && resourceTypes[logicalId]
                                ? new RawTs(pascalToCamel(generateCdkId(logicalId, servicePrefix)))
                                : d.Value;
                    }
                    return { dimensionsMap: map };
                },
            ],
            [
                'Namespace',
                (v, allProps, _resourceTypes, servicePrefix) => {
                    const metricName = allProps['MetricName'];
                    const dimensionsMap = allProps['dimensionsMap'];
                    const period = allProps['Period'];
                    const statistic = allProps['Statistic'] ?? allProps['ExtendedStatistic'];

                    delete allProps['MetricName'];
                    delete allProps['dimensionsMap'];
                    delete allProps['Period'];
                    delete allProps['Statistic'];
                    delete allProps['ExtendedStatistic'];

                    const parts: string[] = [`namespace: ${valueToTs(v, servicePrefix)}`];
                    if (metricName !== undefined)
                        parts.push(`metricName: ${valueToTs(metricName, servicePrefix)}`);
                    if (dimensionsMap !== undefined)
                        parts.push(`dimensionsMap: ${valueToTs(dimensionsMap, servicePrefix)}`);
                    if (typeof period === 'number')
                        parts.push(`period: cdk.Duration.seconds(${period})`);
                    else if (period !== undefined)
                        parts.push(`period: ${valueToTs(period, servicePrefix)}`);
                    if (statistic !== undefined)
                        parts.push(`statistic: ${valueToTs(statistic, servicePrefix)}`);

                    return { metric: new RawTs(`new cw.Metric({ ${parts.join(', ')} })`) };
                },
            ],
            [
                'ComparisonOperator',
                v => ({
                    comparisonOperator:
                        typeof v === 'string'
                            ? new RawTs(
                                  `cw.ComparisonOperator.${v
                                      .replace(/([A-Z])/g, '_$1')
                                      .replace(/^_/, '')
                                      .toUpperCase()}`
                              )
                            : v,
                }),
            ],
            [
                'TreatMissingData',
                v => ({
                    treatMissingData:
                        typeof v === 'string'
                            ? new RawTs(
                                  `cw.TreatMissingData.${v.replace(/([A-Z])/g, '_$1').toUpperCase()}`
                              )
                            : v,
                }),
            ],
        ]),
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

    // Logs
    'AWS::Logs::MetricFilter': {
        cdkModule: 'aws-cdk-lib/aws-logs',
        importAlias: 'logs',
        className: 'MetricFilter',
        cfnNameProp: 'FilterName',
        omitProps: new Set(),
        propExpansions: new Map<
            string,
            (
                v: unknown,
                allProps: Record<string, unknown>,
                resourceTypes: Record<string, string>,
                servicePrefix: string
            ) => Record<string, unknown>
        >([
            [
                'LogGroupName',
                (v, _allProps, _resourceTypes, servicePrefix) => ({
                    logGroup: new RawTs(
                        `logs.LogGroup.fromLogGroupName(this, 'LogGroup', ${valueToTs(v, servicePrefix)})`
                    ),
                }),
            ],
            [
                'FilterPattern',
                (v, _allProps, _resourceTypes, servicePrefix) => ({
                    filterPattern: new RawTs(
                        `logs.FilterPattern.literal(${valueToTs(v, servicePrefix)})`
                    ),
                }),
            ],
            [
                'MetricTransformations',
                v => {
                    const transforms = (v ?? []) as Array<Record<string, unknown>>;
                    const t = transforms[0] ?? {};
                    const result: Record<string, unknown> = {};
                    if (t['MetricName']) result['metricName'] = t['MetricName'];
                    if (t['MetricNamespace']) result['metricNamespace'] = t['MetricNamespace'];
                    if (t['MetricValue'] !== undefined) result['metricValue'] = t['MetricValue'];
                    if (t['DefaultValue'] !== undefined) result['defaultValue'] = t['DefaultValue'];
                    return result;
                },
            ],
            ['FilterName', v => ({ filterName: v })],
        ]),
    },
};
