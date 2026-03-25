import type { ResourceEntry } from '../../types/index.js';
import { pascalToCamel, RawTs, valueToTs } from '../cfn-to-ts.js';
import { buildConstructStatement } from '../resource-processor.js';

export function buildUsagePlanStatements(
    entry: ResourceEntry,
    restApiEntries: ResourceEntry[],
    apiKeyEntries: ResourceEntry[]
): string[] {
    const usagePlanVar = pascalToCamel(entry.logicalId.cdkId);
    const statements: string[] = [buildConstructStatement(entry)];

    for (const restApiEntry of restApiEntries) {
        const restApiVar = pascalToCamel(restApiEntry.logicalId.cdkId);
        statements.push(
            `${usagePlanVar}.addApiStage({ api: ${restApiVar} as apigw.IRestApi, stage: ${restApiVar}.deploymentStage });`
        );
    }

    for (const apiKeyEntry of apiKeyEntries) {
        const apiKeyVar = pascalToCamel(apiKeyEntry.logicalId.cdkId);
        statements.push(`${usagePlanVar}.addApiKey(${apiKeyVar});`);
    }

    return statements;
}

export function buildApiGatewayMethodStatement(entry: ResourceEntry): string {
    const { cdkId } = entry.logicalId;
    const varName = pascalToCamel(cdkId);
    const props = { ...entry.properties };

    const resourceRef = props['resourceRef'];
    const httpMethod = props['HttpMethod'];
    const integrationRef = props['integrationRef'];
    delete props['resourceRef'];
    delete props['HttpMethod'];
    delete props['integrationRef'];

    const resourceExpr =
        resourceRef instanceof RawTs ? resourceRef.code : `/* TODO: resolve ResourceId */`;
    const integrationExpr =
        integrationRef instanceof RawTs ? integrationRef.code : `/* TODO: add integration */`;
    const optionsTs = Object.keys(props).length > 0 ? `, ${valueToTs(props)}` : '';

    return `const ${varName} = ${resourceExpr}.addMethod(${valueToTs(httpMethod)}, ${integrationExpr}${optionsTs});`;
}

export function buildApiGatewayResourceStatement(entry: ResourceEntry): string {
    const { cdkId } = entry.logicalId;
    const varName = pascalToCamel(cdkId);
    const props = entry.properties;

    const parentRef = props['parentRef'];
    const pathPart = props['PathPart'];

    const parentExpr = parentRef instanceof RawTs ? parentRef.code : `/* TODO: resolve ParentId */`;

    return `const ${varName} = ${parentExpr}.addResource(${valueToTs(pathPart)});`;
}
