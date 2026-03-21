import * as path from 'node:path';

import type {
    CdkMapping,
    CloudFormationTemplate,
    GeneratedResource,
    ResourceEntry,
    SkippedResource,
    StateMachineDefinitionInfo,
} from '../types/index.js';
import { generateCdkId, pascalToCamel, valueToTs } from './cfn-to-ts.js';
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

export function buildStateMachineStatement(
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
