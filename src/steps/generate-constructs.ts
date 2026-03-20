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
    StateMachineDefinitionInfo,
} from '../types/index.js';
import { RawTs, pascalToCamel, valueToTs } from '../utils/cfn-to-ts.js';

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
        omitProps: new Set(['Code', 'Handler', 'Runtime', 'Role']),
        propTransforms: new Map([
            ['Timeout', v => (typeof v === 'number' ? new RawTs(`Duration.seconds(${v})`) : v)],
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
                v => (typeof v === 'string' ? new RawTs(`StateMachineType.${v}`) : v),
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

/**
 * Derives a CDK construct ID from a CloudFormation logical ID by stripping
 * well-known Serverless Framework suffixes (e.g. `MyFuncLambdaFunction` → `MyFunc`).
 */
export function generateCdkId(logicalId: string): string {
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

    if (mapping.propTransforms) {
        for (const [key, transform] of mapping.propTransforms) {
            if (key in result) {
                result[key] = transform(result[key]);
            }
        }
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

function buildStateMachineStatement(
    entry: ResourceEntry,
    definitionInfo: StateMachineDefinitionInfo | undefined,
    sourceFilePath: string
): string {
    const { cdkId } = entry.logicalId;
    const varName = pascalToCamel(cdkId);
    const propLines: string[] = [];

    if (entry.properties['StateMachineName'] !== undefined) {
        propLines.push(
            `    stateMachineName: ${valueToTs(entry.properties['StateMachineName'], 2)},`
        );
    }
    if (entry.properties['StateMachineType'] !== undefined) {
        propLines.push(
            `    stateMachineType: ${valueToTs(entry.properties['StateMachineType'], 2)},`
        );
    }

    const tracingConfig = entry.properties['TracingConfiguration'];
    if (tracingConfig && typeof tracingConfig === 'object') {
        const enabled = (tracingConfig as Record<string, unknown>)['Enabled'];
        if (enabled !== undefined) {
            propLines.push(`    tracingEnabled: ${valueToTs(enabled, 2)},`);
        }
    }

    if (definitionInfo) {
        const sourceDir = path.dirname(sourceFilePath);
        const relYamlPath = path.relative(sourceDir, definitionInfo.yamlPath).replace(/\\/g, '/');
        propLines.push(`    filepath: path.join(__dirname, '${relYamlPath}'),`);

        const lambdaSubs = definitionInfo.substitutions.filter(s => s.isLambda);
        if (lambdaSubs.length > 0) {
            const lambdaEntries = lambdaSubs.map(s => `        ${s.cdkVarName},`).join('\n');
            propLines.push(`    lambdaFunctions: [\n${lambdaEntries}\n    ],`);
        }

        const nonLambdaSubs = definitionInfo.substitutions.filter(s => !s.isLambda);
        if (nonLambdaSubs.length > 0) {
            const subEntries = nonLambdaSubs
                .map(
                    s =>
                        `        ${s.cdkVarName}: '', ` +
                        `// TODO: replace with correct CDK expression`
                )
                .join('\n');
            propLines.push(`    definitionSubstitutions: {\n${subEntries}\n    },`);
        }
    } else {
        propLines.push(
            `    // TODO: DefinitionString was not Fn::Sub — provide definitionFileName manually`
        );
        propLines.push(`    definitionFileName: '',`);
    }

    const handledKeys = new Set(['StateMachineName', 'StateMachineType', 'TracingConfiguration']);
    for (const [k, v] of Object.entries(entry.properties)) {
        if (!handledKeys.has(k)) {
            propLines.push(`    // TODO: ${k}: ${valueToTs(v, 2)},`);
        }
    }

    const propsBlock = propLines.join('\n');
    return (
        `const ${varName} = new ${entry.mapping.importAlias}.${entry.mapping.className}` +
        `(this, '${cdkId}', {\n${propsBlock}\n});`
    );
}

function applyToSourceFile(
    sourceFile: SourceFile,
    entries: ResourceEntry[],
    moduleAliases: Map<string, string>,
    stateMachineDefinitions: Record<string, StateMachineDefinitionInfo>
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

    const hasStateMachines = moduleAliases.has('@aligent/cdk-step-function-from-file');
    if (hasStateMachines) {
        if (
            !sourceFile.getImportDeclaration(
                d => d.getModuleSpecifierValue() === 'aws-cdk-lib/aws-stepfunctions'
            )
        ) {
            sourceFile.addImportDeclaration({
                namespaceImport: 'sfn',
                moduleSpecifier: 'aws-cdk-lib/aws-stepfunctions',
            });
        }
        if (!sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === 'node:path')) {
            sourceFile.addImportDeclaration({
                namespaceImport: 'path',
                moduleSpecifier: 'node:path',
            });
        }
    }

    // Resolve class: by name if provided, otherwise fall back to the first class in the file
    const classDecl = sourceFile.getClasses()[0];
    if (!classDecl) return;

    const ctor = classDecl.getConstructors()[0];
    if (!ctor) return;

    const sourceFilePath = sourceFile.getFilePath();
    const existingBody = ctor.getBody()?.getText() ?? '';
    for (const entry of entries) {
        const { cdkId, cfnLogicalId } = entry.logicalId;
        if (existingBody.includes(`'${cdkId}'`)) continue;

        const comments: string[] = [];
        if (entry.condition) {
            comments.push(`\n// Condition: ${entry.condition}`);
        }
        if (entry.dependsOn && entry.dependsOn.length > 0) {
            comments.push(`// DependsOn: ${entry.dependsOn.join(', ')}`);
        }
        comments.push(`// ${cfnLogicalId} (${entry.cfnType})`);
        comments.push(`// TODO: Review and adjust properties for ${entry.mapping.className}`);

        let constructStatement: string;
        if (entry.mapping.className === 'StepFunctionFromFile') {
            const definitionInfo = stateMachineDefinitions[cfnLogicalId];
            constructStatement = buildStateMachineStatement(entry, definitionInfo, sourceFilePath);
        } else {
            const varName = pascalToCamel(cdkId);
            constructStatement =
                `const ${varName} = new ${entry.mapping.importAlias}.${entry.mapping.className}` +
                `(this, '${cdkId}', ${valueToTs(entry.properties, 2)});`;
        }

        ctor.addStatements([...comments, constructStatement].join('\n'));
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
    destinationServicePath: string,
    stateMachineDefinitions: Record<string, StateMachineDefinitionInfo>
): GenerateConstructsResult {
    const outputPath = path.join(destinationServicePath, 'src', 'index.ts');
    if (!fs.existsSync(outputPath)) {
        throw new Error(`Output file not found: ${outputPath}`);
    }

    const { entries, moduleAliases, generated, skipped } = resolveResources(template, keepNames);

    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(outputPath);

    applyToSourceFile(sourceFile, entries, moduleAliases, stateMachineDefinitions);
    project.saveSync();

    return {
        outputPath,
        generated,
        skipped,
        generatedCount: generated.length,
        skippedCount: skipped.length,
    };
}
