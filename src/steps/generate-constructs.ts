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
import { generateLambdaFunctionsFile, resolveEnvValue } from '../utils/lambda-file-generator.js';
import {
    buildApiGatewayMethodStatement,
    buildApiGatewayResourceStatement,
    buildConstructStatement,
    buildStateMachineStatement,
    buildUsagePlanStatements,
    resolveResources,
} from '../utils/resource-processor.js';

function ensureImports(
    sourceFile: SourceFile,
    entries: ResourceEntry[],
    moduleAliases: Map<string, string>,
    lambdaEntries: ResourceEntry[]
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
}

function applyToSourceFile(
    sourceFile: SourceFile,
    nonLambdaEntries: ResourceEntry[],
    moduleAliases: Map<string, string>,
    stateMachineDefinitions: Record<string, StateMachineDefinitionInfo>,
    sharedEnvVars: EnvVarEntry[],
    ssmPlaceholderMap: Map<string, string>,
    lambdaEntries: ResourceEntry[]
): void {
    ensureImports(sourceFile, nonLambdaEntries, moduleAliases, lambdaEntries);

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
            .map(v => `${v.name}: ${resolveEnvValue(v.value, ssmPlaceholderMap)}`)
            .join(', ');
        ctor.addStatements(`const sharedEnv = { ${envProps} };`);
    }

    const nonLambdaVpcEntries = nonLambdaEntries.filter(e => 'vpc' in e.properties);
    if (nonLambdaVpcEntries.length && !existingBody.includes('vpcConfig')) {
        const { vpc, vpcSubnets, securityGroups } = nonLambdaVpcEntries[0]!.properties;
        ctor.addStatements(
            `const vpcConfig = ${valueToTs({ vpc, vpcSubnets, securityGroups }).replaceAll('scope,', 'this,')};`
        );
    }

    if (lambdaEntries.length > 0 && !existingBody.includes('lambdaFunctions(')) {
        const lambdaVarNames = lambdaEntries.map(e => pascalToCamel(e.logicalId.cdkId));
        ctor.addStatements(
            `const { ${lambdaVarNames.join(', ')} } = lambdaFunctions(this, props);`
        );
    }

    const restApiEntries = nonLambdaEntries.filter(e => e.cfnType === 'AWS::ApiGateway::RestApi');
    const apiKeyEntries = nonLambdaEntries.filter(e => e.cfnType === 'AWS::ApiGateway::ApiKey');

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
            const statement = buildStateMachineStatement(entry, definitionInfo, sourceFilePath);
            ctor.addStatements([...comments, statement].join('\n'));
            continue;
        }

        if (entry.cfnType === 'AWS::ApiGateway::Resource') {
            ctor.addStatements([...comments, buildApiGatewayResourceStatement(entry)].join('\n'));
            continue;
        }

        if (entry.cfnType === 'AWS::ApiGateway::Method') {
            ctor.addStatements([...comments, buildApiGatewayMethodStatement(entry)].join('\n'));
            continue;
        }

        if (entry.cfnType === 'AWS::ApiGateway::UsagePlan') {
            const statements = buildUsagePlanStatements(entry, restApiEntries, apiKeyEntries);
            ctor.addStatements([...comments, ...statements].join('\n'));
            continue;
        }

        ctor.addStatements([...comments, buildConstructStatement(entry)].join('\n'));
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
    ssmPlaceholderMap: Map<string, string> = new Map()
): GenerateConstructsResult {
    const outputPath = path.join(destinationServicePath, 'src', 'index.ts');
    if (!fs.existsSync(outputPath)) {
        throw new Error(`Output file not found: ${outputPath}`);
    }

    const { entries, generated, skipped } = resolveResources(template, keepNames);

    const lambdaEntries = entries.filter(e => e.cfnType === 'AWS::Lambda::Function');

    const commonEnvKeys = new Set(sharedEnvVars.map(v => v.name));
    generateLambdaFunctionsFile(
        lambdaEntries,
        sharedEnvVars,
        commonEnvKeys,
        ssmPlaceholderMap,
        destinationServicePath
    );

    const nonLambdaEntries = entries.filter(e => e.cfnType !== 'AWS::Lambda::Function');

    // Module aliases only for non-lambda constructs (lambdas go to their own file)
    const nonLambdaModuleAliases = new Map<string, string>();
    for (const entry of nonLambdaEntries) {
        if (!nonLambdaModuleAliases.has(entry.mapping.cdkModule)) {
            nonLambdaModuleAliases.set(entry.mapping.cdkModule, entry.mapping.importAlias);
        }
    }

    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(outputPath);

    applyToSourceFile(
        sourceFile,
        nonLambdaEntries,
        nonLambdaModuleAliases,
        stateMachineDefinitions,
        sharedEnvVars,
        ssmPlaceholderMap,
        lambdaEntries
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
