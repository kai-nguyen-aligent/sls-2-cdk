import type {
  CloudFormationTemplate,
  MappedResource,
  ResourceMap,
} from '../types/index.js'

function normalizeDependsOn(dependsOn?: string | string[]): string[] {
  if (!dependsOn) return []
  if (typeof dependsOn === 'string') return [dependsOn]
  return dependsOn
}

export function buildResourceMap(template: CloudFormationTemplate): ResourceMap {
  const byType: Record<string, MappedResource[]> = {}
  const byLogicalId: Record<string, MappedResource> = {}
  const summary: Record<string, number> = {}

  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    const mapped: MappedResource = {
      logicalId,
      type: resource.Type,
      properties: (resource.Properties ?? {}) as Record<string, unknown>,
      dependsOn: normalizeDependsOn(resource.DependsOn),
      condition: resource.Condition,
    }

    const existing = byType[resource.Type]
    if (existing) {
      existing.push(mapped)
    } else {
      byType[resource.Type] = [mapped]
    }

    byLogicalId[logicalId] = mapped

    summary[resource.Type] = (summary[resource.Type] ?? 0) + 1
  }

  return {
    byType,
    byLogicalId,
    summary,
    totalCount: Object.keys(byLogicalId).length,
  }
}
