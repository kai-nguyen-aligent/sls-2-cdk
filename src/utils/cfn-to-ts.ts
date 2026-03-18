const INDENT = '    ';

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

const INTRINSIC_FUNCTIONS = new Set([
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
function pascalToCamel(str: string): string {
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
 * Converts a CFN property key to camelCase.
 * ALL_CAPS keys (e.g., TABLE_NAME) are preserved as-is.
 */
function convertPropertyKey(key: string): string {
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) return key;
    return pascalToCamel(key);
}

function escapeString(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function detectIntrinsic(value: unknown): { fn: string; arg: unknown } | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length !== 1 || !keys[0]) return null;
    const key = keys[0];
    if (!INTRINSIC_FUNCTIONS.has(key)) return null;
    return { fn: key, arg: (value as Record<string, unknown>)[key] as unknown };
}

/**
 * Converts a CloudFormation intrinsic function to CDK TypeScript code.
 */
function intrinsicToTs(fn: string, arg: unknown, depth: number): string {
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
                return `cdk.Fn.sub('${escapeString(template)}', ${valueToTs(vars, depth)})`;
            }
            return `cdk.Fn.sub(${valueToTs(arg, depth)})`;
        }
        case 'Fn::ImportValue':
            return `cdk.Fn.importValue('${escapeString(String(arg))}')`;
        case 'Fn::Join': {
            const [delimiter, values] = arg as [string, unknown[]];
            return `cdk.Fn.join('${escapeString(delimiter)}', ${valueToTs(values, depth)})`;
        }
        case 'Fn::Select': {
            const [index, list] = arg as [number, unknown[]];
            return `cdk.Fn.select(${index}, ${valueToTs(list, depth)})`;
        }
        case 'Fn::Split': {
            const [delim, source] = arg as [string, unknown];
            return `cdk.Fn.split('${escapeString(delim)}', ${valueToTs(source, depth)})`;
        }
        case 'Fn::If': {
            const [cond, thenVal, elseVal] = arg as [string, unknown, unknown];
            return `cdk.Fn.conditionIf('${escapeString(cond)}', ${valueToTs(thenVal, depth)}, ${valueToTs(elseVal, depth)})`;
        }
        case 'Fn::FindInMap': {
            const [mapName, first, second] = arg as [string, unknown, unknown];
            return `cdk.Fn.findInMap('${escapeString(mapName)}', ${valueToTs(first, depth)}, ${valueToTs(second, depth)})`;
        }
        case 'Fn::Base64':
            return `cdk.Fn.base64(${valueToTs(arg, depth)})`;
        default:
            return `/* Unsupported intrinsic: ${fn} */ ${valueToTs(arg, depth)}`;
    }
}

/**
 * Converts a CloudFormation value to a TypeScript code string.
 * Property keys are converted from PascalCase to camelCase.
 * Intrinsic functions are mapped to cdk.Fn.* helpers.
 */
export function valueToTs(value: unknown, depth: number): string {
    const intrinsic = detectIntrinsic(value);
    if (intrinsic) return intrinsicToTs(intrinsic.fn, intrinsic.arg, depth);

    if (value === null || value === undefined) return 'undefined';
    if (typeof value === 'string') return `'${escapeString(value)}'`;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const innerIndent = INDENT.repeat(depth + 1);
        const closeIndent = INDENT.repeat(depth);
        const items = value.map(v => `${innerIndent}${valueToTs(v, depth + 1)}`);
        return `[\n${items.join(',\n')},\n${closeIndent}]`;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return '{}';
        const innerIndent = INDENT.repeat(depth + 1);
        const closeIndent = INDENT.repeat(depth);
        const props = entries.map(
            ([k, v]) => `${innerIndent}${convertPropertyKey(k)}: ${valueToTs(v, depth + 1)}`
        );
        return `{\n${props.join(',\n')},\n${closeIndent}}`;
    }

    return String(value);
}
