import * as fs from 'node:fs';
import * as path from 'node:path';

import { Project, type SourceFile } from 'ts-morph';

import type {
    CdkIdMapping,
    CdkMapping,
    CloudFormationTemplate,
    EnvVarEntry,
    GenerateConstructsResult,
    GeneratedResource,
    SkippedResource,
    StateMachineDefinitionInfo,
} from '../types/index.js';
import { RawTs, pascalToCamel, valueToTs } from '../utils/cfn-to-ts.js';
import { CFN_TO_CDK, IGNORE_LOGICAL_IDS, SLS_LOGICAL_ID_SUFFIXES } from '../utils/construct-map.js';

/**
 * Derives a CDK construct ID from a CloudFormation logical ID by stripping
 * well-known Serverless Framework suffixes (e.g. `MyFuncLambdaFunction` → `MyFunc`).
 */
export function generateCdkId(logicalId: string): string {
    const sanitized = logicalId.replace(/Dash|Underscore/g, '');
    for (const suffix of SLS_LOGICAL_ID_SUFFIXES) {
        if (sanitized.endsWith(suffix) && sanitized.length > suffix.length) {
            return sanitized.slice(0, -suffix.length);
        }
    }
    return sanitized;
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

    if (mapping.propExpansions) {
        for (const [key, expand] of mapping.propExpansions) {
            if (key in result) {
                Object.assign(result, expand(result[key]));
                delete result[key];
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

/**
 * Resolves a lambda env var value to a TypeScript expression.
 * If the value is a known SSM placeholder, emits the CDK props reference instead.
 */
function resolveEnvValue(value: unknown, ssmPlaceholderMap: Map<string, string>): string {
    if (typeof value === 'string') {
        const cdkRef = ssmPlaceholderMap.get(value);
        if (cdkRef) return cdkRef;
    }
    return valueToTs(value);
}

/**
 * Builds the TypeScript expression for a lambda's `environment` property,
 * spreading `sharedEnv` for common vars and inlining unique ones.
 */
function buildLambdaEnvTs(
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

// FIXME: Probably not needed. We should always have PROPS.
// Double check the latest generator
/**
 * Like {@link resolveEnvValue} but for use inside `lambda-functions.ts` where `props` is
 * typed as `SharedInfraProps` (non-optional). Strips the `!` non-null assertion from CDK refs.
 */
function resolveEnvValueForFile(value: unknown, ssmPlaceholderMap: Map<string, string>): string {
    if (typeof value === 'string') {
        const cdkRef = ssmPlaceholderMap.get(value);
        if (cdkRef) return cdkRef.replace('props!.', 'props.');
    }
    return valueToTs(value);
}

/**
 * Builds the TypeScript expression for a lambda's `environment` property inside
 * `lambda-functions.ts`, spreading `sharedEnv` and resolving SSM refs without `!`.
 */
function buildLambdaEnvForFile(
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

function buildStateMachineStatement(
    entry: ResourceEntry,
    definitionInfo: StateMachineDefinitionInfo | undefined,
    sourceFilePath: string
): string {
    const { cdkId } = entry.logicalId;
    const varName = pascalToCamel(cdkId);
    const propLines: string[] = [];

    if (entry.properties['StateMachineName'] !== undefined) {
        propLines.push(`stateMachineName: ${valueToTs(entry.properties['StateMachineName'])},`);
    }
    if (entry.properties['StateMachineType'] !== undefined) {
        propLines.push(`stateMachineType: ${valueToTs(entry.properties['StateMachineType'])},`);
    }

    const tracingConfig = entry.properties['TracingConfiguration'];
    if (tracingConfig && typeof tracingConfig === 'object') {
        const enabled = (tracingConfig as Record<string, unknown>)['Enabled'];
        if (enabled !== undefined) {
            propLines.push(`tracingEnabled: ${valueToTs(enabled)},`);
        }
    }

    if (definitionInfo) {
        const sourceDir = path.dirname(sourceFilePath);
        const relYamlPath = path.relative(sourceDir, definitionInfo.yamlPath).replace(/\\/g, '/');
        propLines.push(`filepath: '${relYamlPath}',`);

        const lambdaSubs = definitionInfo.substitutions.filter(s => s.isLambda);
        if (lambdaSubs.length > 0) {
            const lambdaEntries = lambdaSubs.map(s => `        ${s.cdkVarName},`).join('\n');
            propLines.push(`lambdaFunctions: [\n${lambdaEntries}\n],`);
        }

        const nonLambdaSubs = definitionInfo.substitutions.filter(s => !s.isLambda);
        if (nonLambdaSubs.length > 0) {
            const subEntries = nonLambdaSubs
                .map(s => `${s.cdkVarName}: '', ` + `// TODO: replace with correct CDK expression`)
                .join('\n');
            propLines.push(`definitionSubstitutions: {\n${subEntries}\n    },`);
        }
    } else {
        propLines.push(
            `// TODO: DefinitionString was not Fn::Sub — provide definitionFileName manually`
        );
        propLines.push(`definitionFileName: '',`);
    }

    const handledKeys = new Set(['StateMachineName', 'StateMachineType', 'TracingConfiguration']);
    for (const [k, v] of Object.entries(entry.properties)) {
        if (!handledKeys.has(k)) {
            propLines.push(`// TODO: ${k}: ${valueToTs(v)},`);
        }
    }

    const propsBlock = propLines.join('\n');
    return (
        `const ${varName} = new ${entry.mapping.importAlias}.${entry.mapping.className}` +
        `(this, '${cdkId}', {\n${propsBlock}\n});`
    );
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
function generateLambdaFunctionsFile(
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
        const { vpc, vpcSubnets, securityGroups } = lambdaEntries.find(
            e => 'vpc' in e.properties
        )!.properties;
        const vpcTs = valueToTs({ vpc, vpcSubnets, securityGroups }).replace(/\bthis\b/g, 'scope');
        fn.addStatements(`const vpcConfig = ${vpcTs};`);
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
        if (props['Environment'] && typeof props['Environment'] === 'object') {
            const envVars = props['Environment'] as Record<string, unknown>;
            props = {
                ...props,
                Environment: new RawTs(
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

function applyToSourceFile(
    sourceFile: SourceFile,
    entries: ResourceEntry[],
    moduleAliases: Map<string, string>,
    stateMachineDefinitions: Record<string, StateMachineDefinitionInfo>,
    sharedEnvVars: EnvVarEntry[],
    ssmPlaceholderMap: Map<string, string>,
    lambdaEntries: ResourceEntry[]
): void {
    // Ensure base imports exist
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

    const vpcEntries = entries.filter(e => 'vpc' in e.properties);
    if (vpcEntries.length > 0) {
        if (
            !sourceFile.getImportDeclaration(
                d => d.getModuleSpecifierValue() === 'aws-cdk-lib/aws-ec2'
            )
        ) {
            sourceFile.addImportDeclaration({
                namespaceImport: 'ec2',
                moduleSpecifier: 'aws-cdk-lib/aws-ec2',
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

    // Resolve class: by name if provided, otherwise fall back to the first class in the file
    const classDecl = sourceFile.getClasses()[0];
    if (!classDecl) return;

    const ctor = classDecl.getConstructors()[0];
    if (!ctor) return;

    const commonEnvKeys = new Set(sharedEnvVars.map(v => v.name));
    const hasSharedEnv = commonEnvKeys.size > 0;

    const sourceFilePath = sourceFile.getFilePath();
    const existingBody = ctor.getBody()?.getText() ?? '';

    // sharedEnv stays in index.ts only when there are no extracted lambda functions
    if (hasSharedEnv && lambdaEntries.length === 0 && !existingBody.includes('sharedEnv')) {
        const envProps = sharedEnvVars
            .map(v => `${v.name}: ${resolveEnvValue(v.value, ssmPlaceholderMap)}`)
            .join(', ');
        ctor.addStatements(`const sharedEnv = { ${envProps} };`);
    }

    if (vpcEntries.length > 0 && !existingBody.includes('vpcConfig')) {
        const { vpc, vpcSubnets, securityGroups } = vpcEntries[0]!.properties;
        ctor.addStatements(`const vpcConfig = ${valueToTs({ vpc, vpcSubnets, securityGroups })};`);
    }

    if (lambdaEntries.length > 0 && !existingBody.includes('lambdaFunctions(')) {
        const lambdaVarNames = lambdaEntries.map(e => pascalToCamel(e.logicalId.cdkId));
        const callStmt = `const { ${lambdaVarNames.join(', ')} } = lambdaFunctions(this, props!);`;
        ctor.addStatements(callStmt);
    }

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
            let props = entry.properties;
            if (
                hasSharedEnv &&
                entry.cfnType === 'AWS::Lambda::Function' &&
                props['Environment'] &&
                typeof props['Environment'] === 'object'
            ) {
                const envVars = props['Environment'] as Record<string, unknown>;
                props = {
                    ...props,
                    Environment: new RawTs(
                        buildLambdaEnvTs(envVars, commonEnvKeys, ssmPlaceholderMap)
                    ),
                };
            }
            let propsTs: string;
            if ('vpc' in props) {
                const { vpc: _vpc, vpcSubnets: _vs, securityGroups: _sg, ...rest } = props;
                const restTs = valueToTs(rest);
                propsTs =
                    restTs === '{}'
                        ? '{ ...vpcConfig }'
                        : restTs.replace(/^\{ /, '{ ...vpcConfig, ');
            } else {
                propsTs = valueToTs(props);
            }
            constructStatement =
                `const ${varName} = new ${entry.mapping.importAlias}.${entry.mapping.className}` +
                `(this, '${cdkId}', ${propsTs});`;
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
    const nonLambdaEntries = entries.filter(e => e.cfnType !== 'AWS::Lambda::Function');

    // Module aliases only for non-lambda constructs (lambdas go to their own file)
    const nonLambdaModuleAliases = new Map<string, string>();
    for (const entry of nonLambdaEntries) {
        if (!nonLambdaModuleAliases.has(entry.mapping.cdkModule)) {
            nonLambdaModuleAliases.set(entry.mapping.cdkModule, entry.mapping.importAlias);
        }
    }

    const commonEnvKeys = new Set(sharedEnvVars.map(v => v.name));
    generateLambdaFunctionsFile(
        lambdaEntries,
        sharedEnvVars,
        commonEnvKeys,
        ssmPlaceholderMap,
        destinationServicePath
    );

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
