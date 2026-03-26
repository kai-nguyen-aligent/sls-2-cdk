import type { ResourceEntry } from '../../types/index.js';
import {
    detectIntrinsic,
    generateCdkId,
    pascalToCamel,
    resolveLogicalId,
    valueToTs,
} from '../cfn-to-ts.js';
import { buildConstructStatement } from '../resource-processor.js';

/**
 * Resolves a CloudWatch Alarm action ARN to a CDK `cwActions.*` expression.
 * Supports Lambda and SNS targets resolved via Ref/Fn::GetAtt.
 */
function resolveAlarmAction(
    actionArn: unknown,
    allEntries: ResourceEntry[],
    servicePrefix: string
): string {
    const intrinsic = detectIntrinsic(actionArn);

    const logicalId = resolveLogicalId(intrinsic);

    if (logicalId) {
        const varName = pascalToCamel(generateCdkId(logicalId, servicePrefix));
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

    return `/* TODO: resolve alarm action ARN: ${valueToTs(actionArn, servicePrefix)} */`;
}

export function buildAlarmStatements(
    entry: ResourceEntry,
    allEntries: ResourceEntry[],
    servicePrefix: string
): string[] {
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

    const statements: string[] = [buildConstructStatement(entryWithoutActions, servicePrefix)];

    for (const action of alarmActions) {
        statements.push(
            `${alarmVar}.addAlarmAction(${resolveAlarmAction(action, allEntries, servicePrefix)});`
        );
    }
    for (const action of okActions) {
        statements.push(
            `${alarmVar}.addOkAction(${resolveAlarmAction(action, allEntries, servicePrefix)});`
        );
    }
    for (const action of insufficientDataActions) {
        statements.push(
            `${alarmVar}.addInsufficientDataAction(${resolveAlarmAction(action, allEntries, servicePrefix)});`
        );
    }

    return statements;
}
