import type { ResourceEntry } from '../../types/index.js';
import { detectIntrinsic, generateCdkId, pascalToCamel, valueToTs } from '../cfn-to-ts.js';
import { buildConstructStatement } from '../resource-processor.js';

/**
 * Resolves a CloudWatch Alarm action ARN to a CDK `cwActions.*` expression.
 * Supports Lambda and SNS targets resolved via Ref/Fn::GetAtt.
 */
function resolveAlarmAction(actionArn: unknown, allEntries: ResourceEntry[]): string {
    const intrinsic = detectIntrinsic(actionArn);

    const logicalId =
        intrinsic?.fn === 'Fn::GetAtt'
            ? (intrinsic.arg as [string, string])[0]
            : intrinsic?.fn === 'Ref'
              ? (intrinsic.arg as string)
              : null;

    if (logicalId) {
        const varName = pascalToCamel(generateCdkId(logicalId));
        const matchingEntry = allEntries.find(e => e.logicalId.cfnLogicalId === logicalId);

        switch (matchingEntry?.cfnType) {
            case 'AWS::Lambda::Function':
                return `new cwActions.LambdaAction(${varName})`;
            case 'AWS::SNS::Topic':
                return `new cwActions.SnsAction(${varName})`;
            default:
                return `/* TODO: resolve alarm action for ${logicalId} — wrap with cwActions.* */`;
        }
    }

    return `/* TODO: resolve alarm action ARN: ${valueToTs(actionArn)} */`;
}

export function buildAlarmStatements(entry: ResourceEntry, allEntries: ResourceEntry[]): string[] {
    const alarmVar = pascalToCamel(entry.logicalId.cdkId);

    const alarmActions = (entry.properties['AlarmActions'] ?? []) as unknown[];
    const okActions = (entry.properties['OKActions'] ?? []) as unknown[];
    const insufficientDataActions = (entry.properties['InsufficientDataActions'] ??
        []) as unknown[];

    const entryWithoutActions: ResourceEntry = {
        ...entry,
        properties: Object.fromEntries(
            Object.entries(entry.properties).filter(
                ([k]) => !['AlarmActions', 'OKActions', 'InsufficientDataActions'].includes(k)
            )
        ),
    };

    const statements: string[] = [buildConstructStatement(entryWithoutActions)];

    for (const action of alarmActions) {
        statements.push(`${alarmVar}.addAlarmAction(${resolveAlarmAction(action, allEntries)});`);
    }
    for (const action of okActions) {
        statements.push(`${alarmVar}.addOkAction(${resolveAlarmAction(action, allEntries)});`);
    }
    for (const action of insufficientDataActions) {
        statements.push(
            `${alarmVar}.addInsufficientDataAction(${resolveAlarmAction(action, allEntries)});`
        );
    }

    return statements;
}
