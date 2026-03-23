import * as fs from 'node:fs';
import * as path from 'node:path';

import { Project } from 'ts-morph';

import type { EnvVarEntry, ResourceEntry } from '../types/index.js';
import { RawTs, pascalToCamel, valueToTs } from './cfn-to-ts.js';

/**
 * Resolves a lambda env var value to a TypeScript expression.
 * If the value is a known SSM placeholder, emits the CDK props reference instead.
 */
export function resolveEnvValue(value: unknown, ssmPlaceholderMap: Map<string, string>): string {
    if (typeof value === 'string') {
        const cdkRef = ssmPlaceholderMap.get(value);
        if (cdkRef) return cdkRef;
    }
    return valueToTs(value);
}

// FIXME: Probably not needed. We should always have PROPS.
// Double check the latest generator
/**
 * Like {@link resolveEnvValue} but for use inside `lambda-functions.ts` where `props` is
 * typed as `SharedInfraProps` (non-optional). Strips the `!` non-null assertion from CDK refs.
 */
export function resolveEnvValueForFile(
    value: unknown,
    ssmPlaceholderMap: Map<string, string>
): string {
    if (typeof value === 'string') {
        const cdkRef = ssmPlaceholderMap.get(value);
        if (cdkRef) return cdkRef.replace('props!.', 'props?.');
    }
    return valueToTs(value);
}

/**
 * Builds the TypeScript expression for a lambda's `environment` property,
 * spreading `sharedEnv` for common vars and inlining unique ones.
 */
export function buildLambdaEnvTs(
    envVars: Record<string, unknown>,
    commonKeys: Set<string>,
    ssmPlaceholderMap: Map<string, string>
): string {
    const uniqueEntries = Object.entries(envVars).filter(([k]) => !commonKeys.has(k));
    const parts = [
        '...sharedEnv',
        ...uniqueEntries.map(([k, v]) => `${k}: ${resolveEnvValue(v, ssmPlaceholderMap)}`),
    ];
    return `{ ${parts.join(', ')} }`;
}

/**
 * Builds the TypeScript expression for a lambda's `environment` property inside
 * `lambda-functions.ts`, spreading `sharedEnv` and resolving SSM refs without `!`.
 */
export function buildLambdaEnvForFile(
    envVars: Record<string, unknown>,
    commonKeys: Set<string>,
    ssmPlaceholderMap: Map<string, string>
): string {
    const uniqueEntries = Object.entries(envVars).filter(([k]) => !commonKeys.has(k));
    const parts = [
        ...(commonKeys.size > 0 ? ['...sharedEnv'] : []),
        ...uniqueEntries.map(([k, v]) => `${k}: ${resolveEnvValueForFile(v, ssmPlaceholderMap)}`),
    ];
    return `{ ${parts.join(', ')} }`;
}

/**
 * Generates (or updates) `src/infra/lambda-functions.ts` with all Lambda function
 * constructs extracted from the CloudFormation template. The generated file:
 * - Accepts `SharedInfraProps` as its `props` parameter so callers can pass
 *   the stack props directly (`lambdaFunctions(this, props!)`).
 * - Defines `sharedEnv` internally using `props.xxx.stringValue`.
 * - Defines `vpcConfig` internally when any lambda uses a VPC.
 * - Returns an object containing every lambda construct.
 */
export function generateLambdaFunctionsFile(
    lambdaEntries: ResourceEntry[],
    sharedEnvVars: EnvVarEntry[],
    commonEnvKeys: Set<string>,
    ssmPlaceholderMap: Map<string, string>,
    destinationServicePath: string
): void {
    if (lambdaEntries.length === 0) return;

    const infraDir = path.join(destinationServicePath, 'src', 'infra');
    const outputPath = path.join(infraDir, 'lambda-functions.ts');
    fs.mkdirSync(infraDir, { recursive: true });

    const hasVpc = lambdaEntries.some(e => 'vpc' in e.properties);
    const project = new Project();
    const fileExists = fs.existsSync(outputPath);
    const sourceFile = fileExists
        ? project.addSourceFileAtPath(outputPath)
        : project.createSourceFile(outputPath, '/* v8 ignore start - infrastructure code */\n');

    // --- Imports ---
    const addNsImport = (alias: string, from: string) => {
        if (!sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === from)) {
            sourceFile.addImportDeclaration({ namespaceImport: alias, moduleSpecifier: from });
        }
    };
    const addNamedImport = (namedImports: string[], from: string) => {
        if (!sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === from)) {
            sourceFile.addImportDeclaration({ namedImports, moduleSpecifier: from });
        }
    };

    addNsImport('cdk', 'aws-cdk-lib');
    if (hasVpc) addNsImport('ec2', 'aws-cdk-lib/aws-ec2');
    addNamedImport(['NodejsFunction'], 'aws-cdk-lib/aws-lambda-nodejs');
    addNamedImport(['Construct'], 'constructs');
    addNamedImport(['SharedInfraProps'], '@libs/infra');

    // --- lambdaFunctions function ---
    let fn = sourceFile.getFunction('lambdaFunctions');
    if (!fn) {
        fn = sourceFile.addFunction({
            isExported: true,
            name: 'lambdaFunctions',
            parameters: [
                { name: 'scope', type: 'Construct' },
                { name: 'props', type: 'SharedInfraProps' },
            ],
        });
    }

    const existingFnBody = fn.getBody()?.getText() ?? '';

    // sharedEnv declaration
    if (sharedEnvVars.length > 0 && !existingFnBody.includes('sharedEnv')) {
        const envProps = sharedEnvVars
            .map(v => `${v.name}: ${resolveEnvValueForFile(v.value, ssmPlaceholderMap)}`)
            .join(', ');
        fn.addStatements(`const sharedEnv = { ${envProps} };`);
    }

    // vpcConfig declaration
    if (hasVpc && !existingFnBody.includes('vpcConfig')) {
        const firstVpcEntry = lambdaEntries.find(e => 'vpc' in e.properties)!;
        const { vpc, vpcSubnets, securityGroups } = firstVpcEntry.properties;
        fn.addStatements(`const vpcConfig = ${valueToTs({ vpc, vpcSubnets, securityGroups })};`);
    }

    // Lambda instantiations
    const lambdaVarNames: string[] = [];
    for (const entry of lambdaEntries) {
        const { cdkId, cfnLogicalId } = entry.logicalId;
        const varName = pascalToCamel(cdkId);
        lambdaVarNames.push(varName);

        if (existingFnBody.includes(`'${cdkId}'`)) continue;

        const comments: string[] = [];
        if (entry.condition) {
            comments.push(`// Condition: ${entry.condition}`);
        }
        if (entry.dependsOn && entry.dependsOn.length > 0) {
            comments.push(`// DependsOn: ${entry.dependsOn.join(', ')}`);
        }
        comments.push(`// ${cfnLogicalId} (${entry.cfnType})`);
        comments.push(`// TODO: Review and adjust properties for NodejsFunction`);

        let props = entry.properties;
        if (props['environment'] && typeof props['environment'] === 'object') {
            const envVars = props['environment'] as Record<string, unknown>;
            props = {
                ...props,
                environment: new RawTs(
                    buildLambdaEnvForFile(envVars, commonEnvKeys, ssmPlaceholderMap)
                ),
            };
        }

        let propsTs: string;
        if ('vpc' in props) {
            const { vpc: _v, vpcSubnets: _vs, securityGroups: _sg, ...rest } = props;
            const restTs = valueToTs(rest);
            propsTs =
                restTs === '{}' ? '{ ...vpcConfig }' : restTs.replace(/^\{ /, '{ ...vpcConfig, ');
        } else {
            propsTs = valueToTs(props);
        }
        propsTs = propsTs.replace(/\bthis\b/g, 'scope');

        const stmt = `const ${varName} = new NodejsFunction(scope, '${cdkId}', ${propsTs});`;
        fn.addStatements([...comments, stmt].join('\n'));
    }

    // Return statement (only added on initial generation)
    if (!existingFnBody.includes('return {')) {
        fn.addStatements(`return { ${lambdaVarNames.join(', ')} };`);
    }

    project.saveSync();
}
