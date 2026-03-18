import * as fs from 'node:fs';
import * as path from 'node:path';

import { Project, type SourceFile } from 'ts-morph';

import type {
    CdkIdMapping,
    CdkMapping,
    CloudFormationTemplate,
    GenerateConstructsResult,
    GeneratedResource,
    SkippedResource,
} from '../types/index.js';
import { valueToTs } from '../utils/cfn-to-ts.js';

/**
 * Suffixes appended by Serverless Framework to CloudFormation logical IDs.
 * Stripped when generating CDK construct IDs.
 */
const SLS_LOGICAL_ID_SUFFIXES = ['LambdaFunction', 'LambdaLayer'] as const;

/**
 * Logical IDs of CloudFormation resources to skip during construct generation.
 * These are Serverless Framework infrastructure resources that should not be
 * migrated to CDK constructs.
 */
const IGNORE_LOGICAL_IDS = new Set<string>([
    'ServerlessDeploymentBucket',
    'ServerlessDeploymentBucketPolicy',
    'IamRoleLambdaExecution',
]);

/**
 * Explicit mapping of CloudFormation resource types to CDK L2 constructs.
 * Resources not in this map are skipped during generation.
 */
const CFN_TO_CDK: Record<string, CdkMapping> = {
    // Lambda
    'AWS::Lambda::Function': {
        cdkModule: 'aws-cdk-lib/aws-lambda-nodejs',
        importAlias: 'lambdaNodejs',
        className: 'NodejsFunction',
        cfnNameProp: 'FunctionName',
        omitProps: new Set(['Code', 'Handler']),
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
    'AWS::StepFunctions::StateMachine': {
        cdkModule: 'aws-cdk-lib/aws-stepfunctions',
        importAlias: 'sfn',
        className: 'StateMachine',
        cfnNameProp: 'StateMachineName',
        // TODO: We do not want this here because we use the yaml file + lambda substitution
        omitProps: new Set(['DefinitionString']),
    },

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

    // API Gateway
    'AWS::ApiGateway::RestApi': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        className: 'RestApi',
        cfnNameProp: 'Name',
        omitProps: new Set(),
    },
    // TODO: ApiKey, UsagePlan

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

/**
 * Derives a CDK construct ID from a CloudFormation logical ID by stripping
 * well-known Serverless Framework suffixes (e.g. `MyFuncLambdaFunction` → `MyFunc`).
 */
function generateCdkId(logicalId: string): string {
    for (const suffix of SLS_LOGICAL_ID_SUFFIXES) {
        if (logicalId.endsWith(suffix) && logicalId.length > suffix.length) {
            return logicalId.slice(0, -suffix.length);
        }
    }
    return logicalId;
}

/**
 * Preprocesses CloudFormation resource properties for CDK construct generation.
 * - Returns an empty object when the resource has no properties.
 * - Strips the resource name property when `keepNames` is false.
 * - Drops properties that have no equivalent on the CDK L2 construct.
 */
function processProperties(
    mapping: CdkMapping,
    keepNames: boolean,
    properties: Record<string, unknown> | undefined
): Record<string, unknown> {
    if (!properties) return {};

    const result = { ...properties };

    if (!keepNames && mapping.cfnNameProp) {
        delete result[mapping.cfnNameProp];
    }

    for (const key of mapping.omitProps) {
        delete result[key];
    }

    return result;
}

interface ResourceEntry {
    /** CloudFormation logical ID of the resource (e.g. `MyLambdaFunction`). */
    logicalId: CdkIdMapping;
    /** CloudFormation resource type (e.g. `AWS::Lambda::Function`). */
    cfnType: string;
    /** Resolved CDK L2 construct mapping for this resource type. */
    mapping: CdkMapping;
    /** Raw CloudFormation resource properties, keyed as they appear in the template. */
    properties: Record<string, unknown>;
    /** Logical IDs this resource explicitly depends on, if any. */
    dependsOn?: string[] | undefined;
    /** Name of the CloudFormation condition that gates this resource, if any. */
    condition?: string | undefined;
}

interface ResolvedResources {
    entries: ResourceEntry[];
    moduleAliases: Map<string, string>;
    generated: GeneratedResource[];
    skipped: SkippedResource[];
}

function resolveResources(template: CloudFormationTemplate, keepNames: boolean): ResolvedResources {
    const entries: ResourceEntry[] = [];
    const moduleAliases = new Map<string, string>();
    const generated: GeneratedResource[] = [];
    const skipped: SkippedResource[] = [];

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (IGNORE_LOGICAL_IDS.has(logicalId)) {
            skipped.push({
                logicalId,
                cfnType: resource.Type,
                reason: `Ignored by logical ID`,
            });
            continue;
        }

        const mapping = CFN_TO_CDK[resource.Type];
        if (!mapping) {
            skipped.push({
                logicalId,
                cfnType: resource.Type,
                reason: `No CDK mapping for ${resource.Type}`,
            });
            continue;
        }

        const dependsOn = resource.DependsOn
            ? Array.isArray(resource.DependsOn)
                ? resource.DependsOn
                : [resource.DependsOn]
            : undefined;

        const cdkId = generateCdkId(logicalId);
        const properties: Record<string, unknown> = processProperties(
            mapping,
            keepNames,
            resource.Properties
        );

        entries.push({
            logicalId: { cfnLogicalId: logicalId, cdkId },
            cfnType: resource.Type,
            mapping,
            properties,
            dependsOn,
            condition: resource.Condition,
        });

        generated.push({
            logicalId,
            cfnType: resource.Type,
            cdkModule: mapping.cdkModule,
            cdkClass: `${mapping.importAlias}.${mapping.className}`,
        });

        if (!moduleAliases.has(mapping.cdkModule)) {
            moduleAliases.set(mapping.cdkModule, mapping.importAlias);
        }
    }

    return { entries, moduleAliases, generated, skipped };
}

function applyToSourceFile(
    sourceFile: SourceFile,
    entries: ResourceEntry[],
    moduleAliases: Map<string, string>
): void {
    // Ensure base imports exist
    if (!sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === 'constructs')) {
        sourceFile.addImportDeclaration({
            namedImports: ['Construct'],
            moduleSpecifier: 'constructs',
        });
    }
    if (!sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === 'aws-cdk-lib')) {
        sourceFile.addImportDeclaration({
            namespaceImport: 'cdk',
            moduleSpecifier: 'aws-cdk-lib',
        });
    }
    for (const [modulePath, alias] of moduleAliases) {
        if (!sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === modulePath)) {
            sourceFile.addImportDeclaration({
                namespaceImport: alias,
                moduleSpecifier: modulePath,
            });
        }
    }

    // Resolve class: by name if provided, otherwise fall back to the first class in the file
    const classDecl = sourceFile.getClasses()[0];
    if (!classDecl) return;

    const ctor = classDecl.getConstructors()[0];
    if (!ctor) return;

    const existingBody = ctor.getBody()?.getText() ?? '';
    for (const entry of entries) {
        const { cdkId, cfnLogicalId } = entry.logicalId;
        if (existingBody.includes(`'${cdkId}'`)) continue;

        const statements: string[] = [];
        if (entry.condition) {
            statements.push(`// Condition: ${entry.condition}`);
        }
        if (entry.dependsOn && entry.dependsOn.length > 0) {
            statements.push(`// DependsOn: ${entry.dependsOn.join(', ')}`);
        }
        statements.push(`// ${cfnLogicalId} (${entry.cfnType})`);
        statements.push(`// TODO: Review and adjust properties for ${entry.mapping.className}`);

        statements.push(
            `new ${entry.mapping.importAlias}.${entry.mapping.className}(this, '${cdkId}', ${valueToTs(entry.properties, 2)});`
        );
        ctor.addStatements(statements.join('\n'));
    }
}

/**
 * Generates CDK L2 constructs from a CloudFormation template and writes
 * the construct file to the destination service directory using ts-morph.
 *
 * Uses an explicit mapping (CFN_TO_CDK) to resolve CloudFormation resource
 * types to their CDK L2 construct counterparts. Resources not in the map
 * are skipped.
 *
 * If the output file already exists it is read and only missing imports and
 * construct instantiations are added; existing content is preserved.
 */
export function generateConstructs(
    template: CloudFormationTemplate,
    keepNames: boolean,
    destinationServicePath: string
): GenerateConstructsResult {
    const outputPath = path.join(destinationServicePath, 'src', 'index.ts');
    if (!fs.existsSync(outputPath)) {
        throw new Error(`Output file not found: ${outputPath}`);
    }

    const { entries, moduleAliases, generated, skipped } = resolveResources(template, keepNames);

    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(outputPath);

    applyToSourceFile(sourceFile, entries, moduleAliases);
    project.saveSync();

    return {
        outputPath,
        generated,
        skipped,
        generatedCount: generated.length,
        skippedCount: skipped.length,
    };
}
