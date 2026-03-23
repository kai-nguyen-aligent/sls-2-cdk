import * as path from 'node:path';

import type {
    CdkMapping,
    CloudFormationTemplate,
    GeneratedResource,
    ResourceEntry,
    SkippedResource,
    StateMachineDefinitionInfo,
} from '../types/index.js';
import { detectIntrinsic, generateCdkId, pascalToCamel, RawTs, valueToTs } from './cfn-to-ts.js';
import { CFN_TO_CDK, IGNORE_LOGICAL_IDS } from './construct-map.js';

interface ResolvedResources {
    entries: ResourceEntry[];
    moduleAliases: Map<string, string>;
    generated: GeneratedResource[];
    skipped: SkippedResource[];
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

    if (mapping.propExpansions) {
        for (const [key, expand] of mapping.propExpansions) {
            if (key in result) {
                Object.assign(result, expand(result[key], result));
                delete result[key];
            }
        }
    }

    return result;
}

export function resolveResources(
    template: CloudFormationTemplate,
    keepNames: boolean
): ResolvedResources {
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

export function buildConstructStatement(entry: ResourceEntry): string {
    const varName = pascalToCamel(entry.logicalId.cdkId);
    const props = { ...entry.properties };

    let propsTs: string;
    if ('vpc' in props) {
        const { vpc: _vpc, vpcSubnets: _vs, securityGroups: _sg, ...rest } = props;
        const restTs = valueToTs(rest);
        propsTs = restTs === '{}' ? '{ ...vpcConfig }' : restTs.replace(/^\{ /, '{ ...vpcConfig, ');
    } else {
        propsTs = valueToTs(props);
    }

    return (
        `const ${varName} = new ${entry.mapping.importAlias}.${entry.mapping.className}` +
        `(this, '${entry.logicalId.cdkId}', ${propsTs});`
    );
}

export function buildUsagePlanStatements(
    entry: ResourceEntry,
    restApiEntries: ResourceEntry[],
    apiKeyEntries: ResourceEntry[]
): string[] {
    const usagePlanVar = pascalToCamel(entry.logicalId.cdkId);
    const statements: string[] = [buildConstructStatement(entry)];

    for (const restApiEntry of restApiEntries) {
        const restApiVar = pascalToCamel(restApiEntry.logicalId.cdkId);
        statements.push(
            `${usagePlanVar}.addApiStage({ api: ${restApiVar}, stage: ${restApiVar}.deploymentStage });`
        );
    }

    for (const apiKeyEntry of apiKeyEntries) {
        const apiKeyVar = pascalToCamel(apiKeyEntry.logicalId.cdkId);
        statements.push(`${usagePlanVar}.addApiKey(${apiKeyVar});`);
    }

    return statements;
}

export function buildApiGatewayMethodStatement(entry: ResourceEntry): string {
    const { cdkId } = entry.logicalId;
    const varName = pascalToCamel(cdkId);
    const props = { ...entry.properties };

    const resourceRef = props['resourceRef'];
    const httpMethod = props['HttpMethod'];
    const integrationRef = props['integrationRef'];
    delete props['resourceRef'];
    delete props['HttpMethod'];
    delete props['integrationRef'];

    const resourceExpr =
        resourceRef instanceof RawTs ? resourceRef.code : `/* TODO: resolve ResourceId */`;
    const integrationExpr =
        integrationRef instanceof RawTs ? integrationRef.code : `/* TODO: add integration */`;
    const optionsTs = Object.keys(props).length > 0 ? `, ${valueToTs(props)}` : '';

    return `const ${varName} = ${resourceExpr}.addMethod(${valueToTs(httpMethod)}, ${integrationExpr}${optionsTs});`;
}

export function buildApiGatewayResourceStatement(entry: ResourceEntry): string {
    const { cdkId } = entry.logicalId;
    const varName = pascalToCamel(cdkId);
    const props = entry.properties;

    const parentRef = props['parentRef'];
    const pathPart = props['PathPart'];

    const parentExpr = parentRef instanceof RawTs ? parentRef.code : `/* TODO: resolve ParentId */`;

    return `const ${varName} = ${parentExpr}.addResource(${valueToTs(pathPart)});`;
}

export function buildStateMachineStatement(
    entry: ResourceEntry,
    definitionInfo: StateMachineDefinitionInfo | undefined,
    sourceFilePath: string
): string {
    const { cdkId } = entry.logicalId;
    const varName = pascalToCamel(cdkId);

    const props = { ...entry.properties };

    if (definitionInfo) {
        const sourceDir = path.dirname(sourceFilePath);
        const relYamlPath = path.relative(sourceDir, definitionInfo.yamlPath).replace(/\\/g, '/');
        props['filepath'] = relYamlPath;

        const lambdaSubs = definitionInfo.substitutions.filter(s => s.isLambda);
        if (lambdaSubs.length > 0) {
            const lambdaEntries = lambdaSubs.map(s => `${s.cdkVarName}`).join(',');
            props['lambdaFunctions'] = new RawTs(`[${lambdaEntries}]`);
        }

        const nonLambdaSubs = definitionInfo.substitutions.filter(s => !s.isLambda);
        if (nonLambdaSubs.length > 0) {
            const subEntries = nonLambdaSubs
                .map(s => `${s.cdkVarName}: '', ` + `// TODO: replace with correct CDK expression`)
                .join('\n');
            props['definitionSubstitutions'] = new RawTs(`{${subEntries}}`);
        }
    } else {
        props['filepath'] = new RawTs(
            `'', + '// FIXME: DefinitionString was not Fn::Sub — provide filepath, lambdaFunctions, & definitionSubstitutions manually'`
        );
    }

    const allProps = valueToTs(props);

    return (
        `const ${varName} = new ${entry.mapping.importAlias}.${entry.mapping.className}` +
        `(this, '${cdkId}', ${allProps});`
    );
}

/**
 * Converts a CloudFormation `InputTransformer` to a CDK `events.RuleTargetInput` expression.
 *
 * For JSON object templates (e.g. `{"fetchTime": <time>}`), each `<varName>` placeholder is
 * replaced with an `events.EventField.fromPath(path)` expression using the `InputPathsMap`.
 *
 * Non-JSON templates fall back to a `fromText()` TODO.
 */
function resolveInputTransformer(inputTransformer: Record<string, unknown>): string {
    const pathsMap = (inputTransformer['InputPathsMap'] ?? {}) as Record<string, string>;
    const template = inputTransformer['InputTemplate'];

    if (typeof template !== 'string') {
        return `events.RuleTargetInput.fromObject(/* TODO: reconstruct InputTransformer */)`;
    }

    // Replace each "<varName>" with the corresponding EventField path expression
    const expanded = template.replace(/<([^>]+)>/g, (_match, name: string) => {
        const path = pathsMap[name] ?? '$.unknown';
        return `events.EventField.fromPath('${path}')`;
    });

    // If the expanded result looks like a JSON object template, emit fromObject()
    if (expanded.trimStart().startsWith('{')) {
        return `events.RuleTargetInput.fromObject(${expanded})`;
    }

    return `events.RuleTargetInput.fromText(${expanded})`;
}

/**
 * Resolves an EventBridge Rule target to a CDK `eventsTargets.*` expression.
 * Supports Lambda, Step Functions, SQS, and SNS targets resolved via Ref/Fn::GetAtt.
 * Handles `InputTransformer` by reconstructing a `events.RuleTargetInput` option.
 */
function resolveEventTarget(target: Record<string, unknown>, allEntries: ResourceEntry[]): string {
    const intrinsic = detectIntrinsic(target['Arn']);

    const logicalId =
        intrinsic?.fn === 'Fn::GetAtt'
            ? (intrinsic.arg as [string, string])[0]
            : intrinsic?.fn === 'Ref'
              ? (intrinsic.arg as string)
              : null;

    const inputOpt =
        target['InputTransformer'] && typeof target['InputTransformer'] === 'object'
            ? `, { input: ${resolveInputTransformer(target['InputTransformer'] as Record<string, unknown>)} }`
            : '';

    if (logicalId) {
        const varName = pascalToCamel(generateCdkId(logicalId));
        const matchingEntry = allEntries.find(e => e.logicalId.cfnLogicalId === logicalId);

        switch (matchingEntry?.cfnType) {
            case 'AWS::Lambda::Function':
                return `new eventsTargets.LambdaFunction(${varName}${inputOpt})`;
            case 'AWS::StepFunctions::StateMachine':
                return `new eventsTargets.SfnStateMachine(${varName}${inputOpt})`;
            case 'AWS::SQS::Queue':
                return `new eventsTargets.SqsQueue(${varName}${inputOpt})`;
            case 'AWS::SNS::Topic':
                return `new eventsTargets.SnsTopic(${varName}${inputOpt})`;
            default:
                return `/* TODO: resolve target for ${logicalId} — wrap with eventsTargets.* */`;
        }
    }

    return `/* TODO: resolve target ARN: ${valueToTs(target['Arn'])} */`;
}

export function buildEventRuleStatements(
    entry: ResourceEntry,
    allEntries: ResourceEntry[]
): string[] {
    const ruleVar = pascalToCamel(entry.logicalId.cdkId);

    // Extract Targets before building the construct (not a direct CDK prop)
    const rawTargets = (entry.properties['Targets'] ?? []) as Array<Record<string, unknown>>;
    const entryWithoutTargets: ResourceEntry = {
        ...entry,
        properties: Object.fromEntries(
            Object.entries(entry.properties).filter(([k]) => k !== 'Targets')
        ),
    };

    const statements: string[] = [buildConstructStatement(entryWithoutTargets)];

    for (const target of rawTargets) {
        const targetExpr = resolveEventTarget(target, allEntries);
        statements.push(`${ruleVar}.addTarget(${targetExpr});`);
    }

    return statements;
}
