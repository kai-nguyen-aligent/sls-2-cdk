import type {
  CloudFormationTemplate,
  EnvVarEntry,
  LambdaEnvVars,
  LambdaEnvMap,
} from '../types/index.js'

const INTRINSIC_FUNCTIONS = [
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
]

function detectIntrinsicType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length !== 1) return undefined
  const key = keys[0]
  if (!key) return undefined
  return INTRINSIC_FUNCTIONS.find((fn) => key === fn)
}

function makeEnvVarEntry(name: string, value: unknown): EnvVarEntry {
  const intrinsicType = detectIntrinsicType(value)
  if (intrinsicType) {
    return { name, value, isIntrinsic: true, intrinsicType }
  }
  return { name, value, isIntrinsic: false }
}

function findSharedVariables(functions: LambdaEnvVars[]): EnvVarEntry[] {
  if (functions.length <= 1) return []

  const varsByName = new Map<string, unknown[]>()
  for (const fn of functions) {
    for (const v of fn.variables) {
      if (!varsByName.has(v.name)) {
        varsByName.set(v.name, [])
      }
      varsByName.get(v.name)!.push(v.value)
    }
  }

  const shared: EnvVarEntry[] = []
  for (const [name, values] of varsByName) {
    if (values.length !== functions.length) continue

    const serialized = values.map((v) => JSON.stringify(v))
    const allSame = serialized.every((s) => s === serialized[0])
    if (allSame) {
      shared.push(makeEnvVarEntry(name, values[0]))
    }
  }

  return shared
}

export function buildEnvMap(template: CloudFormationTemplate): LambdaEnvMap {
  const functions: LambdaEnvVars[] = []

  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue
    if (!resource.Properties) continue

    const props = resource.Properties as Record<string, unknown>
    const envBlock = props.Environment as Record<string, unknown> | undefined
    if (!envBlock) continue

    const variables = envBlock.Variables as Record<string, unknown> | undefined
    if (!variables) continue

    const entries: EnvVarEntry[] = Object.entries(variables).map(
      ([name, value]) => makeEnvVarEntry(name, value),
    )

    functions.push({
      logicalId,
      functionName: props.FunctionName as string | undefined,
      handler: props.Handler as string | undefined,
      runtime: props.Runtime as string | undefined,
      variables: entries,
    })
  }

  const allVarNames = new Set<string>()
  for (const fn of functions) {
    for (const v of fn.variables) {
      allVarNames.add(v.name)
    }
  }

  const sharedVariables = findSharedVariables(functions)

  return {
    functions,
    allUniqueVarNames: [...allVarNames].sort(),
    sharedVariables,
    functionCount: functions.length,
  }
}
