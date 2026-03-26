import * as fs from 'node:fs';
import * as path from 'node:path';

import { Project, type SourceFile } from 'ts-morph';

import type {
    CloudFormationTemplate,
    EnvVarEntry,
    GenerateConstructsResult,
    ResourceEntry,
    StateMachineDefinitionInfo,
} from '../types/index.js';
import { pascalToCamel, valueToTs } from '../utils/cfn-to-ts.js';
import { buildConstructStatement, resolveResources } from '../utils/resource-processor.js';
import { CFN_TYPE_ORDER } from '../utils/resources-config.js';
import {
    extractApiGwIntegrationVarNames,
    generateApiGatewayFile,
} from '../utils/resources/api-gateway.js';
import { buildAlarmStatements } from '../utils/resources/cloudwatch-alarm.js';
import { buildEventRuleStatements } from '../utils/resources/event-bridge.js';
import {
    generateLambdaFunctionsFile,
    resolveEnvValue,
} from '../utils/resources/lambda-functions.js';
import { buildStateMachineStatement } from '../utils/resources/state-machine.js';

const API_GW_TYPES = new Set([
    'AWS::ApiGateway::RestApi',
    'AWS::ApiGateway::ApiKey',
    'AWS::ApiGateway::RequestValidator',
    'AWS::ApiGateway::Resource',
    'AWS::ApiGateway::Method',
    'AWS::ApiGateway::UsagePlan',
]);

function ensureImports(
    sourceFile: SourceFile,
    entries: ResourceEntry[],
    moduleAliases: Map<string, string>,
    lambdaEntries: ResourceEntry[],
    apiGwEntries: ResourceEntry[]
): void {
    if (!sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === 'constructs')) {
        sourceFile.addImportDeclaration({
            namedImports: ['Construct'],
            moduleSpecifier: 'constructs',
        });
    }
    if (
        !sourceFile.getImportDeclaration(
            d =>
                d.getModuleSpecifierValue() === 'aws-cdk-lib' &&
                d.getNamespaceImport() !== undefined
        )
    ) {
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

    const hasVpc = entries.some(e => 'vpc' in e.properties);
    if (
        hasVpc &&
        !sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === 'aws-cdk-lib/aws-ec2')
    ) {
        sourceFile.addImportDeclaration({
            namespaceImport: 'ec2',
            moduleSpecifier: 'aws-cdk-lib/aws-ec2',
        });
    }

    const hasLambdaPermission = entries.some(e => e.cfnType === 'AWS::Lambda::Permission');
    if (
        hasLambdaPermission &&
        !sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === 'aws-cdk-lib/aws-iam')
    ) {
        sourceFile.addImportDeclaration({
            namespaceImport: 'iam',
            moduleSpecifier: 'aws-cdk-lib/aws-iam',
        });
    }

    if (
        moduleAliases.has('@aligent/cdk-step-function-from-file') &&
        !sourceFile.getImportDeclaration(
            d => d.getModuleSpecifierValue() === 'aws-cdk-lib/aws-stepfunctions'
        )
    ) {
        sourceFile.addImportDeclaration({
            namespaceImport: 'sfn',
            moduleSpecifier: 'aws-cdk-lib/aws-stepfunctions',
        });
    }

    const hasEventRuleWithTargets = entries.some(
        e =>
            e.cfnType === 'AWS::Events::Rule' &&
            Array.isArray(e.properties['Targets']) &&
            (e.properties['Targets'] as unknown[]).length > 0
    );
    if (
        hasEventRuleWithTargets &&
        !sourceFile.getImportDeclaration(
            d => d.getModuleSpecifierValue() === 'aws-cdk-lib/aws-events-targets'
        )
    ) {
        sourceFile.addImportDeclaration({
            namespaceImport: 'eventsTargets',
            moduleSpecifier: 'aws-cdk-lib/aws-events-targets',
        });
    }

    const hasAlarmWithActions = entries.some(
        e =>
            e.cfnType === 'AWS::CloudWatch::Alarm' &&
            (['AlarmActions', 'OKActions', 'InsufficientDataActions'] as const).some(
                k => Array.isArray(e.properties[k]) && (e.properties[k] as unknown[]).length > 0
            )
    );
    if (
        hasAlarmWithActions &&
        !sourceFile.getImportDeclaration(
            d => d.getModuleSpecifierValue() === 'aws-cdk-lib/aws-cloudwatch-actions'
        )
    ) {
        sourceFile.addImportDeclaration({
            namespaceImport: 'cwActions',
            moduleSpecifier: 'aws-cdk-lib/aws-cloudwatch-actions',
        });
    }

    if (
        lambdaEntries.length > 0 &&
        !sourceFile.getImportDeclaration(
            d => d.getModuleSpecifierValue() === './infra/lambda-functions.js'
        )
    ) {
        sourceFile.addImportDeclaration({
            namedImports: ['lambdaFunctions'],
            moduleSpecifier: './infra/lambda-functions.js',
        });
    }

    if (
        apiGwEntries.length > 0 &&
        !sourceFile.getImportDeclaration(
            d => d.getModuleSpecifierValue() === './infra/api-gateway.js'
        )
    ) {
        sourceFile.addImportDeclaration({
            namedImports: ['ApiGatewayResources'],
            moduleSpecifier: './infra/api-gateway.js',
        });
    }
}

function generateIndexFile(
    sourceFile: SourceFile,
    nonLambdaEntries: ResourceEntry[],
    moduleAliases: Map<string, string>,
    stateMachineDefinitions: Record<string, StateMachineDefinitionInfo>,
    sharedEnvVars: EnvVarEntry[],
    ssmPlaceholderMap: Map<string, string>,
    lambdaEntries: ResourceEntry[],
    apiGwEntries: ResourceEntry[],
    servicePrefix: string
): void {
    ensureImports(sourceFile, nonLambdaEntries, moduleAliases, lambdaEntries, apiGwEntries);

    // Resolve class: by name if provided, otherwise fall back to the first class in the file
    const classDecl = sourceFile.getClasses()[0];
    if (!classDecl) return;

    const ctor = classDecl.getConstructors()[0];
    if (!ctor) return;

    const commonEnvKeys = new Set(sharedEnvVars.map(v => v.name));
    const hasSharedEnv = commonEnvKeys.size > 0;

    const sourceFilePath = sourceFile.getFilePath();
    const existingBody = ctor.getBody()?.getText() ?? '';

    if (!existingBody.includes('IAM roles are intentionally omitted')) {
        ctor.addStatements(
            `// FIXME: IAM roles are intentionally omitted.\n` +
                `// Serverless Framework uses a single shared role for all resources.\n` +
                `// Define more granular IAM roles and permissions per resource here.`
        );
    }

    // sharedEnv stays in index.ts only when there are no extracted lambda functions
    if (hasSharedEnv && lambdaEntries.length === 0 && !existingBody.includes('sharedEnv')) {
        const envProps = sharedEnvVars
            .map(v => `${v.name}: ${resolveEnvValue(v.value, ssmPlaceholderMap, servicePrefix)}`)
            .join(', ');
        ctor.addStatements(`const sharedEnv = { ${envProps} };`);
    }

    const nonLambdaVpcEntries = nonLambdaEntries.filter(e => 'vpc' in e.properties);
    if (nonLambdaVpcEntries.length && !existingBody.includes('vpcConfig')) {
        const { vpc, vpcSubnets, securityGroups } = nonLambdaVpcEntries[0]!.properties;
        ctor.addStatements(
            `const vpcConfig = ${valueToTs({ vpc, vpcSubnets, securityGroups }, servicePrefix).replaceAll('scope,', 'this,')};`
        );
    }

    if (lambdaEntries.length > 0 && !existingBody.includes('lambdaFunctions(')) {
        const lambdaVarNames = lambdaEntries.map(e => pascalToCamel(e.logicalId.cdkId));
        ctor.addStatements(
            `const { ${lambdaVarNames.join(', ')} } = lambdaFunctions(this, props);`
        );
    }

    for (const entry of nonLambdaEntries) {
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

        if (entry.mapping.className === 'StepFunctionFromFile') {
            const definitionInfo = stateMachineDefinitions[cfnLogicalId];
            const statement = buildStateMachineStatement(
                entry,
                definitionInfo,
                sourceFilePath,
                servicePrefix
            );
            ctor.addStatements([...comments, statement].join('\n'));
            continue;
        }

        if (entry.cfnType === 'AWS::Events::Rule') {
            const allEntries = [...nonLambdaEntries, ...lambdaEntries];
            const statements = buildEventRuleStatements(entry, allEntries, servicePrefix);
            ctor.addStatements([...comments, ...statements].join('\n'));
            continue;
        }

        if (entry.cfnType === 'AWS::CloudWatch::Alarm') {
            const allEntries = [...nonLambdaEntries, ...lambdaEntries];
            const statements = buildAlarmStatements(entry, allEntries, servicePrefix);
            ctor.addStatements([...comments, ...statements].join('\n'));
            continue;
        }

        ctor.addStatements([...comments, buildConstructStatement(entry, servicePrefix)].join('\n'));
    }

    if (apiGwEntries.length > 0 && !existingBody.includes('ApiGatewayResources(')) {
        const { lambdaVarNames, sqsVarNames, sfnVarNames } =
            extractApiGwIntegrationVarNames(apiGwEntries);

        const args: string[] = ['this'];
        if (lambdaVarNames.length > 0) {
            args.push(`{ ${lambdaVarNames.join(', ')} }`);
        }
        if (sqsVarNames.length > 0) {
            args.push(`{ ${sqsVarNames.join(', ')} }`);
        }
        if (sfnVarNames.length > 0) {
            args.push(`{ ${sfnVarNames.join(', ')} }`);
        }

        ctor.addStatements(`new ApiGatewayResources(${args.join(', ')});`);
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
    stateMachineDefinitions: Record<string, StateMachineDefinitionInfo>,
    sharedEnvVars: EnvVarEntry[] = [],
    ssmPlaceholderMap: Map<string, string> = new Map(),
    servicePrefix: string
): GenerateConstructsResult {
    const outputPath = path.join(destinationServicePath, 'src', 'index.ts');
    if (!fs.existsSync(outputPath)) {
        throw new Error(`Output file not found: ${outputPath}`);
    }

    const { entries, generated, skipped } = resolveResources(template, keepNames, servicePrefix);
    const commonEnvKeys = new Set(sharedEnvVars.map(v => v.name));

    const lambdaEntries = entries.filter(e => e.cfnType === 'AWS::Lambda::Function');
    generateLambdaFunctionsFile(
        lambdaEntries,
        sharedEnvVars,
        commonEnvKeys,
        ssmPlaceholderMap,
        destinationServicePath,
        servicePrefix
    );

    const apiGwEntries = entries
        .filter(e => API_GW_TYPES.has(e.cfnType))
        .sort((a, b) => (CFN_TYPE_ORDER[a.cfnType] ?? 0) - (CFN_TYPE_ORDER[b.cfnType] ?? 0));
    generateApiGatewayFile(apiGwEntries, destinationServicePath, servicePrefix);

    const nonLambdaEntries = entries
        .filter(e => e.cfnType !== 'AWS::Lambda::Function' && !API_GW_TYPES.has(e.cfnType))
        .sort((a, b) => (CFN_TYPE_ORDER[a.cfnType] ?? 0) - (CFN_TYPE_ORDER[b.cfnType] ?? 0));

    // Module aliases only for non-lambda, non-API GW constructs
    const nonLambdaModuleAliases = new Map<string, string>();
    for (const entry of nonLambdaEntries) {
        if (!nonLambdaModuleAliases.has(entry.mapping.cdkModule)) {
            nonLambdaModuleAliases.set(entry.mapping.cdkModule, entry.mapping.importAlias);
        }
    }

    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(outputPath);

    generateIndexFile(
        sourceFile,
        nonLambdaEntries,
        nonLambdaModuleAliases,
        stateMachineDefinitions,
        sharedEnvVars,
        ssmPlaceholderMap,
        lambdaEntries,
        apiGwEntries,
        servicePrefix
    );
    project.saveSync();

    return {
        outputPath,
        generated,
        skipped,
        generatedCount: generated.length,
        skippedCount: skipped.length,
    };
}
