import type { ResourceEntry } from '../../types/index.js';
import { detectIntrinsic, generateCdkId, pascalToCamel, valueToTs } from '../cfn-to-ts.js';
import { buildConstructStatement } from '../resource-processor.js';

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
