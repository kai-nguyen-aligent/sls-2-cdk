import type {
    CloudFormationTemplate,
    EnvVarEntry,
    LambdaEnvMap,
    LambdaEnvVars,
} from '../types/index.js';
import { detectIntrinsic } from '../utils/cfn-to-ts.js';

function makeEnvVarEntry(name: string, value: unknown, isShared = false): EnvVarEntry {
    const intrinsic = detectIntrinsic(value);
    if (intrinsic) {
        return { name, value, isIntrinsic: true, intrinsicType: intrinsic.fn, isShared };
    }
    return { name, value, isIntrinsic: false, isShared };
}

function findSharedVariables(functions: LambdaEnvVars[]): EnvVarEntry[] {
    if (functions.length <= 1) return [];

    const varsByName = new Map<string, unknown[]>();
    for (const fn of functions) {
        for (const v of fn.variables) {
            if (!varsByName.has(v.name)) {
                varsByName.set(v.name, []);
            }
            varsByName.get(v.name)!.push(v.value);
        }
    }

    const shared: EnvVarEntry[] = [];
    for (const [name, values] of varsByName) {
        if (values.length !== functions.length) continue;

        const serialized = values.map(v => JSON.stringify(v));
        const allSame = serialized.every(s => s === serialized[0]);
        if (allSame) {
            shared.push(makeEnvVarEntry(name, values[0]));
        }
    }

    return shared;
}

export function buildEnvMap(template: CloudFormationTemplate): LambdaEnvMap {
    const functions: LambdaEnvVars[] = [];

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (resource.Type !== 'AWS::Lambda::Function') continue;
        if (!resource.Properties) continue;

        const props = resource.Properties as Record<string, unknown>;
        const envBlock = props.Environment as Record<string, unknown> | undefined;
        if (!envBlock) continue;

        const variables = envBlock.Variables as Record<string, unknown> | undefined;
        if (!variables) continue;

        const entries: EnvVarEntry[] = Object.entries(variables).map(([name, value]) =>
            makeEnvVarEntry(name, value)
        );

        functions.push({
            logicalId,
            functionName: props.FunctionName as string | undefined,
            handler: props.Handler as string | undefined,
            runtime: props.Runtime as string | undefined,
            variables: entries,
        });
    }

    const allVarNames = new Set<string>();
    for (const fn of functions) {
        for (const v of fn.variables) {
            allVarNames.add(v.name);
        }
    }

    const sharedVariables = findSharedVariables(functions);
    const sharedNames = new Set(sharedVariables.map(v => v.name));

    for (const fn of functions) {
        fn.variables = fn.variables.map(v => ({ ...v, isShared: sharedNames.has(v.name) }));
    }

    return {
        functions,
        allUniqueVarNames: [...allVarNames].sort(),
        sharedVariables,
        functionCount: functions.length,
    };
}
