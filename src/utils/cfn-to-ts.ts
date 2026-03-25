import { SLS_LOGICAL_ID_SUFFIXES } from './construct-map.js';

/** Wraps a TypeScript expression that should be emitted verbatim without quoting. */
export class RawTs {
    constructor(public readonly code: string) {}
}

/** CloudFormation pseudo-parameters mapped to CDK constants */
const PSEUDO_PARAMS: Record<string, string> = {
    'AWS::AccountId': 'cdk.Aws.ACCOUNT_ID',
    'AWS::NotificationARNs': 'cdk.Aws.NOTIFICATION_ARNS',
    'AWS::NoValue': 'cdk.Aws.NO_VALUE',
    'AWS::Partition': 'cdk.Aws.PARTITION',
    'AWS::Region': 'cdk.Aws.REGION',
    'AWS::StackId': 'cdk.Aws.STACK_ID',
    'AWS::StackName': 'cdk.Aws.STACK_NAME',
    'AWS::URLSuffix': 'cdk.Aws.URL_SUFFIX',
};

export const INTRINSIC_FUNCTIONS = new Set([
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
]);

/**
 * Converts a PascalCase string to camelCase.
 * Handles leading acronyms (e.g., SSEAlgorithm -> sseAlgorithm).
 */
export function pascalToCamel(str: string): string {
    let i = 0;
    while (i < str.length) {
        const ch = str[i]!;
        if (ch < 'A' || ch > 'Z') break;
        i++;
    }
    if (i === 0) return str;
    if (i === 1) return str[0]!.toLowerCase() + str.slice(1);
    if (i >= str.length) return str.toLowerCase();
    return str.slice(0, i - 1).toLowerCase() + str.slice(i - 1);
}

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

/** Returns true if the key is a valid JS identifier and can be used unquoted. */
function isValidIdentifier(key: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

/**
 * Converts a CFN property key to camelCase.
 * ALL_CAPS keys (e.g., TABLE_NAME) are preserved as-is.
 * Keys that are not valid JS identifiers (e.g. containing dots) are single-quoted.
 */
function convertPropertyKey(key: string): string {
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) return key;
    const camel = pascalToCamel(key);
    return isValidIdentifier(camel) ? camel : `'${escapeString(camel)}'`;
}

function escapeString(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function detectIntrinsic(value: unknown): { fn: string; arg: unknown } | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length !== 1 || !keys[0]) return null;
    const key = keys[0];
    if (!INTRINSIC_FUNCTIONS.has(key)) return null;
    return { fn: key, arg: (value as Record<string, unknown>)[key] as unknown };
}

/**
 * Extracts the logical resource ID from a `Ref` or `Fn::GetAtt` intrinsic, or returns null.
 * - `Ref: LogicalId` → `LogicalId`
 * - `Fn::GetAtt: [LogicalId, Attr]` → `LogicalId`
 */
export function resolveLogicalId(
    intrinsic: { fn: string; arg: unknown } | null | undefined
): string | null {
    if (intrinsic?.fn === 'Fn::GetAtt') return (intrinsic.arg as [string, string])[0];
    if (intrinsic?.fn === 'Ref') return intrinsic.arg as string;
    return null;
}

/**
 * Converts a CloudFormation intrinsic function to CDK TypeScript code.
 */
function intrinsicToTs(fn: string, arg: unknown): string {
    switch (fn) {
        case 'Ref': {
            const pseudo = PSEUDO_PARAMS[arg as string];
            if (pseudo) return pseudo;
            return `cdk.Fn.ref('${escapeString(String(arg))}')`;
        }
        case 'Fn::GetAtt': {
            const [resource, attribute] = arg as [string, string];
            return `cdk.Fn.getAtt('${escapeString(resource)}', '${escapeString(attribute)}')`;
        }
        case 'Fn::Sub': {
            if (typeof arg === 'string') {
                return `cdk.Fn.sub('${escapeString(arg)}')`;
            }
            if (Array.isArray(arg)) {
                const [template, vars] = arg as [string, Record<string, unknown>];
                return `cdk.Fn.sub('${escapeString(template)}', ${valueToTs(vars)})`;
            }
            return `cdk.Fn.sub(${valueToTs(arg)})`;
        }
        case 'Fn::ImportValue':
            return `cdk.Fn.importValue('${escapeString(String(arg))}')`;
        case 'Fn::Join': {
            const [delimiter, values] = arg as [string, unknown[]];
            return `cdk.Fn.join('${escapeString(delimiter)}', ${valueToTs(values)})`;
        }
        case 'Fn::Select': {
            const [index, list] = arg as [number, unknown[]];
            return `cdk.Fn.select(${index}, ${valueToTs(list)})`;
        }
        case 'Fn::Split': {
            const [delim, source] = arg as [string, unknown];
            return `cdk.Fn.split('${escapeString(delim)}', ${valueToTs(source)})`;
        }
        case 'Fn::If': {
            const [cond, thenVal, elseVal] = arg as [string, unknown, unknown];
            return `cdk.Fn.conditionIf('${escapeString(cond)}', ${valueToTs(thenVal)}, ${valueToTs(elseVal)})`;
        }
        case 'Fn::FindInMap': {
            const [mapName, first, second] = arg as [string, unknown, unknown];
            return `cdk.Fn.findInMap('${escapeString(mapName)}', ${valueToTs(first)}, ${valueToTs(second)})`;
        }
        case 'Fn::Base64':
            return `cdk.Fn.base64(${valueToTs(arg)})`;
        default:
            return `/* Unsupported intrinsic: ${fn} */ ${valueToTs(arg)}`;
    }
}

/**
 * Converts a CloudFormation value to a compact TypeScript code string.
 * Property keys are converted from PascalCase to camelCase.
 * Intrinsic functions are mapped to Fn.* helpers.
 * Output is intentionally compact — run prettier to format the generated file.
 */
export function valueToTs(value: unknown): string {
    if (value instanceof RawTs) return value.code;

    const intrinsic = detectIntrinsic(value);
    if (intrinsic) return intrinsicToTs(intrinsic.fn, intrinsic.arg);

    if (value === null || value === undefined) return 'undefined';
    if (typeof value === 'string') return `'${escapeString(value)}'`;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[${value.map(v => valueToTs(v)).join(', ')}]`;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return '{}';
        const props = entries.map(([k, v]) => `${convertPropertyKey(k)}: ${valueToTs(v)}`);
        return `{ ${props.join(', ')} }`;
    }

    return String(value);
}
