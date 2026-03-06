import type {
    CloudFormationResource,
    CloudFormationTemplate,
    RemovedResource,
    RemoveResourcesResult,
    Sls2CdkConfig,
} from '../types/index.js';

function matchesTypePattern(type: string, pattern: string): boolean {
    if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        return type.startsWith(prefix);
    }
    return type === pattern;
}

export function removeResources(
    template: CloudFormationTemplate,
    config: Sls2CdkConfig
): RemoveResourcesResult {
    const removed: RemovedResource[] = [];
    const cleanedResources: Record<string, CloudFormationResource> = {};

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (config.removeResourceIds.includes(logicalId)) {
            removed.push({
                logicalId,
                type: resource.Type,
                reason: 'id_match',
                matchedPattern: logicalId,
            });
            continue;
        }

        const matchedPattern = config.removeResourceTypePatterns.find(pattern =>
            matchesTypePattern(resource.Type, pattern)
        );
        if (matchedPattern) {
            removed.push({
                logicalId,
                type: resource.Type,
                reason: 'type_pattern_match',
                matchedPattern,
            });
            continue;
        }

        cleanedResources[logicalId] = { ...resource };
    }

    // Clean up DependsOn references to removed resources
    const removedIds = new Set(removed.map(r => r.logicalId));
    for (const resource of Object.values(cleanedResources)) {
        if (resource.DependsOn) {
            if (typeof resource.DependsOn === 'string') {
                if (removedIds.has(resource.DependsOn)) {
                    delete resource.DependsOn;
                }
            } else if (Array.isArray(resource.DependsOn)) {
                resource.DependsOn = resource.DependsOn.filter(dep => !removedIds.has(dep));
                if (resource.DependsOn.length === 0) {
                    delete resource.DependsOn;
                }
            }
        }
    }

    // Clean up Outputs that reference removed resources
    let cleanedOutputs: Record<string, unknown> | undefined;
    if (template.Outputs) {
        cleanedOutputs = {};
        for (const [outputId, outputDef] of Object.entries(template.Outputs)) {
            const outputStr = JSON.stringify(outputDef);
            const referencesRemoved = [...removedIds].some(id => outputStr.includes(`"${id}"`));
            if (!referencesRemoved) {
                cleanedOutputs[outputId] = outputDef;
            }
        }
        if (Object.keys(cleanedOutputs).length === 0) {
            cleanedOutputs = undefined;
        }
    }

    const cleanedTemplate: CloudFormationTemplate = {
        ...template,
        Resources: cleanedResources,
        Outputs: cleanedOutputs,
    };

    return {
        template: cleanedTemplate,
        removed,
        remainingCount: Object.keys(cleanedResources).length,
    };
}
