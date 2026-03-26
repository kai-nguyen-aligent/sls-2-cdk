import type {
    CdkMapping,
    CloudFormationTemplate,
    GeneratedResource,
    ResourceEntry,
    SkippedResource,
} from '../types/index.js';
import { generateCdkId, pascalToCamel, valueToTs } from './cfn-to-ts.js';
import { CFN_TO_CDK, IGNORE_LOGICAL_IDS } from './resources-config.js';

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
    properties: Record<string, unknown> | undefined,
    resourceTypes: Record<string, string>,
    servicePrefix: string
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
                Object.assign(result, expand(result[key], result, resourceTypes, servicePrefix));
                delete result[key];
            }
        }
    }

    return result;
}

export function resolveResources(
    template: CloudFormationTemplate,
    keepNames: boolean,
    servicePrefix: string = ''
): ResolvedResources {
    const entries: ResourceEntry[] = [];
    const moduleAliases = new Map<string, string>();
    const generated: GeneratedResource[] = [];
    const skipped: SkippedResource[] = [];
    const resourceTypes = Object.fromEntries(
        Object.entries(template.Resources).map(([id, r]) => [id, r.Type])
    );

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

        const cdkId = generateCdkId(logicalId, servicePrefix);
        const properties: Record<string, unknown> = processProperties(
            mapping,
            keepNames,
            resource.Properties,
            resourceTypes,
            servicePrefix
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

export function buildConstructStatement(entry: ResourceEntry, servicePrefix: string): string {
    const varName = pascalToCamel(entry.logicalId.cdkId);
    const props = { ...entry.properties };

    let propsTs: string;
    if ('vpc' in props) {
        const { vpc: _vpc, vpcSubnets: _vs, securityGroups: _sg, ...rest } = props;
        const restTs = valueToTs(rest, servicePrefix);
        propsTs = restTs === '{}' ? '{ ...vpcConfig }' : restTs.replace(/^\{ /, '{ ...vpcConfig, ');
    } else {
        propsTs = valueToTs(props, servicePrefix);
    }

    return (
        `const ${varName} = new ${entry.mapping.importAlias}.${entry.mapping.className}` +
        `(this, '${entry.logicalId.cdkId}', ${propsTs});`
    );
}
