import * as path from 'node:path';

import { Project } from 'ts-morph';

import type {
    CdkMapping,
    CloudFormationTemplate,
    GenerateConstructsResult,
    GeneratedResource,
    SkippedResource,
} from '../types/index.js';

const INDENT = '    ';

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
    },
    'AWS::Lambda::EventSourceMapping': {
        cdkModule: 'aws-cdk-lib/aws-lambda',
        importAlias: 'lambda',
        className: 'EventSourceMapping',
    },
    'AWS::Lambda::LayerVersion': {
        cdkModule: 'aws-cdk-lib/aws-lambda',
        importAlias: 'lambda',
        className: 'LayerVersion',
    },

    // DynamoDB
    'AWS::DynamoDB::Table': {
        cdkModule: 'aws-cdk-lib/aws-dynamodb',
        importAlias: 'dynamodb',
        className: 'Table',
    },

    // S3
    'AWS::S3::Bucket': {
        cdkModule: 'aws-cdk-lib/aws-s3',
        importAlias: 's3',
        className: 'Bucket',
    },

    // IAM
    'AWS::IAM::Role': {
        cdkModule: 'aws-cdk-lib/aws-iam',
        importAlias: 'iam',
        className: 'Role',
    },
    'AWS::IAM::Policy': {
        cdkModule: 'aws-cdk-lib/aws-iam',
        importAlias: 'iam',
        className: 'Policy',
    },

    // Logs
    'AWS::Logs::LogGroup': {
        cdkModule: 'aws-cdk-lib/aws-logs',
        importAlias: 'logs',
        className: 'LogGroup',
    },

    // Step Functions
    'AWS::StepFunctions::StateMachine': {
        cdkModule: 'aws-cdk-lib/aws-stepfunctions',
        importAlias: 'sfn',
        className: 'StateMachine',
    },

    // SQS
    'AWS::SQS::Queue': {
        cdkModule: 'aws-cdk-lib/aws-sqs',
        importAlias: 'sqs',
        className: 'Queue',
    },

    // SNS
    'AWS::SNS::Topic': {
        cdkModule: 'aws-cdk-lib/aws-sns',
        importAlias: 'sns',
        className: 'Topic',
    },
    'AWS::SNS::Subscription': {
        cdkModule: 'aws-cdk-lib/aws-sns-subscriptions',
        importAlias: 'snsSubscriptions',
        className: 'Subscription',
    },

    // Events
    'AWS::Events::Rule': {
        cdkModule: 'aws-cdk-lib/aws-events',
        importAlias: 'events',
        className: 'Rule',
    },

    // API Gateway
    'AWS::ApiGateway::RestApi': {
        cdkModule: 'aws-cdk-lib/aws-apigateway',
        importAlias: 'apigw',
        className: 'RestApi',
    },

    // CloudWatch
    'AWS::CloudWatch::Alarm': {
        cdkModule: 'aws-cdk-lib/aws-cloudwatch',
        importAlias: 'cw',
        className: 'Alarm',
    },

    // CloudFront
    'AWS::CloudFront::Distribution': {
        cdkModule: 'aws-cdk-lib/aws-cloudfront',
        importAlias: 'cloudfront',
        className: 'Distribution',
    },

    // Cognito
    'AWS::Cognito::UserPool': {
        cdkModule: 'aws-cdk-lib/aws-cognito',
        importAlias: 'cognito',
        className: 'UserPool',
    },

    // SSM
    'AWS::SSM::Parameter': {
        cdkModule: 'aws-cdk-lib/aws-ssm',
        importAlias: 'ssm',
        className: 'StringParameter',
    },

    // Secrets Manager
    'AWS::SecretsManager::Secret': {
        cdkModule: 'aws-cdk-lib/aws-secretsmanager',
        importAlias: 'secretsmanager',
        className: 'Secret',
    },
};

/** CloudFormation pseudo-parameters mapped to CDK constants */
const PSEUDO_PARAMS: Record<string, string> = {
    'AWS::AccountId': 'cdk.Aws.ACCOUNT_ID',
    'AWS::NotificationARNs': 'cdk.Aws.NOTIFICATION_ARNS',
    'AWS::NoValue': 'cdk.Aws.NO_VALUE',
    'AWS::Partition': 'cdk.Aws.PARTITION',
    'AWS::Region': 'cdk.Aws.REGION',
    'AWS::StackId': 'cdk.Aws.STACK_ID',
    'AWS::StackName': 'cdk.Aws.STACK_NAME',
    'AWS::URLSuffix': 'cdk.Aws.URL_SUFFIX',
};

const INTRINSIC_FUNCTIONS = new Set([
    'Ref',
    'Fn::Sub',
    'Fn::GetAtt',
    'Fn::ImportValue',
    'Fn::Join',
    'Fn::Select',
    'Fn::Split',
    'Fn::If',
    'Fn::FindInMap',
    'Fn::Base64',
]);

interface ResourceEntry {
    logicalId: string;
    cfnType: string;
    mapping: CdkMapping;
    properties: Record<string, unknown>;
    dependsOn?: string[] | undefined;
    condition?: string | undefined;
}

/**
 * Converts a PascalCase string to camelCase.
 * Handles leading acronyms (e.g., SSEAlgorithm -> sseAlgorithm).
 */
function pascalToCamel(str: string): string {
    let i = 0;
    while (i < str.length) {
        const ch = str[i]!;
        if (ch < 'A' || ch > 'Z') break;
        i++;
    }
    if (i === 0) return str;
    if (i === 1) return str[0]!.toLowerCase() + str.slice(1);
    if (i >= str.length) return str.toLowerCase();
    return str.slice(0, i - 1).toLowerCase() + str.slice(i - 1);
}

/**
 * Converts a CFN property key to camelCase.
 * ALL_CAPS keys (e.g., TABLE_NAME) are preserved as-is.
 */
function convertPropertyKey(key: string): string {
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) return key;
    return pascalToCamel(key);
}

function escapeString(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function detectIntrinsic(value: unknown): { fn: string; arg: unknown } | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length !== 1 || !keys[0]) return null;
    const key = keys[0];
    if (!INTRINSIC_FUNCTIONS.has(key)) return null;
    return { fn: key, arg: (value as Record<string, unknown>)[key] as unknown };
}

/**
 * Converts a CloudFormation intrinsic function to CDK TypeScript code.
 */
function intrinsicToTs(fn: string, arg: unknown, depth: number): string {
    switch (fn) {
        case 'Ref': {
            const pseudo = PSEUDO_PARAMS[arg as string];
            if (pseudo) return pseudo;
            return `cdk.Fn.ref('${escapeString(String(arg))}')`;
        }
        case 'Fn::GetAtt': {
            const [resource, attribute] = arg as [string, string];
            return `cdk.Fn.getAtt('${escapeString(resource)}', '${escapeString(attribute)}')`;
        }
        case 'Fn::Sub': {
            if (typeof arg === 'string') {
                return `cdk.Fn.sub('${escapeString(arg)}')`;
            }
            if (Array.isArray(arg)) {
                const [template, vars] = arg as [string, Record<string, unknown>];
                return `cdk.Fn.sub('${escapeString(template)}', ${valueToTs(vars, depth)})`;
            }
            return `cdk.Fn.sub(${valueToTs(arg, depth)})`;
        }
        case 'Fn::ImportValue':
            return `cdk.Fn.importValue('${escapeString(String(arg))}')`;
        case 'Fn::Join': {
            const [delimiter, values] = arg as [string, unknown[]];
            return `cdk.Fn.join('${escapeString(delimiter)}', ${valueToTs(values, depth)})`;
        }
        case 'Fn::Select': {
            const [index, list] = arg as [number, unknown[]];
            return `cdk.Fn.select(${index}, ${valueToTs(list, depth)})`;
        }
        case 'Fn::Split': {
            const [delim, source] = arg as [string, unknown];
            return `cdk.Fn.split('${escapeString(delim)}', ${valueToTs(source, depth)})`;
        }
        case 'Fn::If': {
            const [cond, thenVal, elseVal] = arg as [string, unknown, unknown];
            return `cdk.Fn.conditionIf('${escapeString(cond)}', ${valueToTs(thenVal, depth)}, ${valueToTs(elseVal, depth)})`;
        }
        case 'Fn::FindInMap': {
            const [mapName, first, second] = arg as [string, unknown, unknown];
            return `cdk.Fn.findInMap('${escapeString(mapName)}', ${valueToTs(first, depth)}, ${valueToTs(second, depth)})`;
        }
        case 'Fn::Base64':
            return `cdk.Fn.base64(${valueToTs(arg, depth)})`;
        default:
            return `/* Unsupported intrinsic: ${fn} */ ${valueToTs(arg, depth)}`;
    }
}

// TODO: Maybe we don't even need this.
/**
 * Converts a CloudFormation value to a TypeScript code string.
 * Property keys are converted from PascalCase to camelCase.
 * Intrinsic functions are mapped to cdk.Fn.* helpers.
 */
function valueToTs(value: unknown, depth: number): string {
    const intrinsic = detectIntrinsic(value);
    if (intrinsic) return intrinsicToTs(intrinsic.fn, intrinsic.arg, depth);

    if (value === null || value === undefined) return 'undefined';
    if (typeof value === 'string') return `'${escapeString(value)}'`;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const innerIndent = INDENT.repeat(depth + 1);
        const closeIndent = INDENT.repeat(depth);
        const items = value.map(v => `${innerIndent}${valueToTs(v, depth + 1)}`);
        return `[\n${items.join(',\n')},\n${closeIndent}]`;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return '{}';
        const innerIndent = INDENT.repeat(depth + 1);
        const closeIndent = INDENT.repeat(depth);
        const props = entries.map(
            ([k, v]) => `${innerIndent}${convertPropertyKey(k)}: ${valueToTs(v, depth + 1)}`
        );
        return `{\n${props.join(',\n')},\n${closeIndent}}`;
    }

    return String(value);
}

// FIXME: This can be ts-morph instead of line by line
// We also can read the existing source then add entries
/**
 * Builds the full TypeScript source content for the migrated construct file.
 */
function buildFileContent(entries: ResourceEntry[], moduleAliases: Map<string, string>): string {
    const lines: string[] = [];

    lines.push("import { Construct } from 'constructs';");
    lines.push("import * as cdk from 'aws-cdk-lib';");
    for (const [modulePath, alias] of moduleAliases) {
        lines.push(`import * as ${alias} from '${modulePath}';`);
    }
    lines.push('');

    lines.push('export class MigratedResources extends Construct {');
    lines.push(`${INDENT}constructor(scope: Construct, id: string) {`);
    lines.push(`${INDENT}${INDENT}super(scope, id);`);

    for (const entry of entries) {
        lines.push('');
        if (entry.condition) {
            lines.push(`${INDENT}${INDENT}// Condition: ${entry.condition}`);
        }
        if (entry.dependsOn && entry.dependsOn.length > 0) {
            lines.push(`${INDENT}${INDENT}// DependsOn: ${entry.dependsOn.join(', ')}`);
        }
        lines.push(`${INDENT}${INDENT}// ${entry.logicalId} (${entry.cfnType})`);
        lines.push(
            `${INDENT}${INDENT}// TODO: Review and adjust properties for ${entry.mapping.className}`
        );

        const propsCode = valueToTs(entry.properties, 2);
        lines.push(
            `${INDENT}${INDENT}new ${entry.mapping.importAlias}.${entry.mapping.className}(this, '${entry.logicalId}', ${propsCode});`
        );
    }

    lines.push(`${INDENT}}`);
    lines.push('}');
    lines.push('');

    return lines.join('\n');
}

/**
 * Generates CDK L2 constructs from a CloudFormation template and writes
 * the construct file to the destination service directory using ts-morph.
 *
 * Uses an explicit mapping (CFN_TO_CDK) to resolve CloudFormation resource
 * types to their CDK L2 construct counterparts. Resources not in the map
 * are skipped.
 */
export function generateConstructs(
    template: CloudFormationTemplate,
    destinationServicePath: string
): GenerateConstructsResult {
    const generated: GeneratedResource[] = [];
    const skipped: SkippedResource[] = [];

    const entries: ResourceEntry[] = [];
    const moduleAliases = new Map<string, string>();

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
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

        entries.push({
            logicalId,
            cfnType: resource.Type,
            mapping,
            properties: (resource.Properties ?? {}) as Record<string, unknown>,
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

    const content = buildFileContent(entries, moduleAliases);
    const outputPath = path.join(destinationServicePath, 'migrated-resources.ts');

    const project = new Project();
    project.createSourceFile(outputPath, content, { overwrite: true });
    project.saveSync();

    return {
        outputPath,
        generated,
        skipped,
        generatedCount: generated.length,
        skippedCount: skipped.length,
    };
}
