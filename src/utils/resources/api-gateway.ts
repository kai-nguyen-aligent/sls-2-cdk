import * as fs from 'node:fs';
import * as path from 'node:path';

import { Project } from 'ts-morph';

import type { ResourceEntry } from '../../types/index.js';
import { pascalToCamel, RawTs, valueToTs } from '../cfn-to-ts.js';
import { buildConstructStatement } from '../resource-processor.js';

function buildUsagePlanStatements(
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

function buildApiGatewayMethodStatement(entry: ResourceEntry): string {
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

    return `${resourceExpr}.addMethod(${valueToTs(httpMethod)}, ${integrationExpr}${optionsTs});`;
}

function buildApiGatewayResourceStatement(entry: ResourceEntry): string {
    const { cdkId } = entry.logicalId;
    const varName = pascalToCamel(cdkId);
    const props = entry.properties;

    const parentRef = props['parentRef'];
    const pathPart = props['PathPart'];

    const parentExpr = parentRef instanceof RawTs ? parentRef.code : `/* TODO: resolve ParentId */`;

    return `const ${varName} = ${parentExpr}.addResource(${valueToTs(pathPart)});`;
}

/**
 * Strips the `apigw.` module prefix from a statement and returns the transformed
 * code along with the set of api-gateway names that need to be imported.
 */
function processApigwStatement(statement: string): { code: string; apigwImports: Set<string> } {
    const apigwImports = new Set<string>();
    const regex = /\bapigw\.(\w+)/g;
    let match;
    while ((match = regex.exec(statement)) !== null) {
        apigwImports.add(match[1]!);
    }
    const code = statement.replace(/\bapigw\./g, '').replace(/\bthis\b/g, 'scope');
    return { code, apigwImports };
}

/**
 * Scans API Gateway Method entries and extracts variable names referenced in each
 * integration type: LambdaIntegration, AwsIntegration (SQS), and StepFunctionsIntegration.
 */
export function extractApiGwIntegrationVarNames(apiGwEntries: ResourceEntry[]): {
    lambdaVarNames: string[];
    sqsVarNames: string[];
    sfnVarNames: string[];
} {
    const apiGwMethodEntries = apiGwEntries.filter(
        e =>
            e.cfnType === 'AWS::ApiGateway::Method' &&
            e.properties['integrationRef'] instanceof RawTs
    );
    const lambdaVarNames = [
        ...new Set(
            apiGwMethodEntries.flatMap(e => {
                const match = /new apigw\.LambdaIntegration\((\w+)\)/.exec(
                    (e.properties['integrationRef'] as RawTs).code
                );
                return match?.[1] ? [match[1]] : [];
            })
        ),
    ];
    const sqsVarNames = [
        ...new Set(
            apiGwMethodEntries.flatMap(e => {
                const match = /\$\{(\w+)\.queueName\}/.exec(
                    (e.properties['integrationRef'] as RawTs).code
                );
                return match?.[1] ? [match[1]] : [];
            })
        ),
    ];
    const sfnVarNames = [
        ...new Set(
            apiGwMethodEntries.flatMap(e => {
                const match = /StepFunctionsIntegration\.startExecution\((\w+)\)/.exec(
                    (e.properties['integrationRef'] as RawTs).code
                );
                return match?.[1] ? [match[1]] : [];
            })
        ),
    ];
    return { lambdaVarNames, sqsVarNames, sfnVarNames };
}

/**
 * Generates (or updates) `src/infra/api-gateway.ts` with all API Gateway constructs
 * extracted from the CloudFormation template. The generated file:
 * - Exports an `ApiGatewayResources` class.
 * - Uses named imports from `aws-cdk-lib/aws-apigateway`.
 * - Accepts the lambda functions object when Lambda integrations are present.
 * - Accepts SQS queues when AwsIntegration (SQS) integrations are present.
 * - Accepts Step Functions state machines when StepFunctionsIntegration integrations are present.
 */
export function generateApiGatewayFile(
    apiGwEntries: ResourceEntry[],
    destinationServicePath: string
): void {
    if (apiGwEntries.length === 0) return;

    const infraDir = path.join(destinationServicePath, 'src', 'infra');
    const outputPath = path.join(infraDir, 'api-gateway.ts');
    fs.mkdirSync(infraDir, { recursive: true });

    const project = new Project();
    const fileExists = fs.existsSync(outputPath);
    const sourceFile = fileExists
        ? project.addSourceFileAtPath(outputPath)
        : project.createSourceFile(outputPath, '/* v8 ignore start - infrastructure code */\n');

    const { lambdaVarNames, sqsVarNames, sfnVarNames } =
        extractApiGwIntegrationVarNames(apiGwEntries);

    const hasLambdaIntegrations = lambdaVarNames.length > 0;
    const hasSqsIntegrations = sqsVarNames.length > 0;
    const hasSfnIntegrations = sfnVarNames.length > 0;

    // --- Class and constructor ---
    let cls = sourceFile.getClass('ApiGatewayResources');
    if (!cls) {
        cls = sourceFile.addClass({ isExported: true, name: 'ApiGatewayResources' });
    }

    const ctorParams: Array<{ name: string; type: string }> = [
        { name: 'scope', type: 'Construct' },
    ];
    if (hasLambdaIntegrations) {
        ctorParams.push({ name: 'lambdas?', type: 'ReturnType<typeof lambdaFunctions>' });
    }
    if (hasSqsIntegrations) {
        ctorParams.push({ name: 'queues?', type: 'Record<string, sqs.Queue>' });
    }
    if (hasSfnIntegrations) {
        ctorParams.push({ name: 'stateMachines?', type: 'Record<string, sfn.StateMachine>' });
    }

    const ctor = cls.getConstructors()[0] ?? cls.addConstructor({ parameters: ctorParams });

    const existingBody = ctor.getBody()?.getText() ?? '';

    // Lambda destructuring
    if (hasLambdaIntegrations && !existingBody.includes('lambdas')) {
        ctor.addStatements(`const { ${lambdaVarNames.join(', ')} } = lambdas;`);
    }

    // SQS destructuring
    if (hasSqsIntegrations && !existingBody.includes('queues')) {
        ctor.addStatements(`const { ${sqsVarNames.join(', ')} } = queues;`);
    }

    // SFN destructuring
    if (hasSfnIntegrations && !existingBody.includes('stateMachines')) {
        ctor.addStatements(`const { ${sfnVarNames.join(', ')} } = stateMachines;`);
    }

    // --- Resource instantiations ---
    const restApiEntries = apiGwEntries.filter(e => e.cfnType === 'AWS::ApiGateway::RestApi');
    const apiKeyEntries = apiGwEntries.filter(e => e.cfnType === 'AWS::ApiGateway::ApiKey');
    const allApigwImports = new Set<string>();
    const allGeneratedCode: string[] = [];

    for (const entry of apiGwEntries) {
        const { cdkId, cfnLogicalId } = entry.logicalId;
        if (existingBody.includes(`'${cdkId}'`)) continue;

        const comments: string[] = [];
        if (entry.condition) {
            comments.push(`// Condition: ${entry.condition}`);
        }
        if (entry.dependsOn && entry.dependsOn.length > 0) {
            comments.push(`// DependsOn: ${entry.dependsOn.join(', ')}`);
        }
        comments.push(`// ${cfnLogicalId} (${entry.cfnType})`);
        comments.push(`// TODO: Review and adjust properties for ${entry.mapping.className}`);

        let rawStatements: string[];
        if (entry.cfnType === 'AWS::ApiGateway::Resource') {
            rawStatements = [buildApiGatewayResourceStatement(entry)];
        } else if (entry.cfnType === 'AWS::ApiGateway::Method') {
            rawStatements = [buildApiGatewayMethodStatement(entry)];
        } else if (entry.cfnType === 'AWS::ApiGateway::UsagePlan') {
            rawStatements = buildUsagePlanStatements(entry, restApiEntries, apiKeyEntries);
        } else {
            rawStatements = [buildConstructStatement(entry)];
        }

        const processedStatements = rawStatements.map(s => {
            const { code, apigwImports } = processApigwStatement(s);
            for (const name of apigwImports) allApigwImports.add(name);
            return code;
        });

        allGeneratedCode.push([...comments, ...processedStatements].join('\n'));
        ctor.addStatements([...comments, ...processedStatements].join('\n'));
    }

    // --- Imports (added after collecting all needed names) ---
    const addNsImport = (alias: string, from: string) => {
        if (!sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === from)) {
            sourceFile.addImportDeclaration({ namespaceImport: alias, moduleSpecifier: from });
        }
    };
    const addNamedImport = (names: string[], from: string) => {
        if (!sourceFile.getImportDeclaration(d => d.getModuleSpecifierValue() === from)) {
            sourceFile.addImportDeclaration({ namedImports: names, moduleSpecifier: from });
        }
    };

    if (
        allGeneratedCode.some(c => c.includes('cdk.')) ||
        (hasLambdaIntegrations && existingBody.includes('lambdas ??'))
    ) {
        addNsImport('cdk', 'aws-cdk-lib');
    }

    if (hasSqsIntegrations) {
        addNsImport('sqs', 'aws-cdk-lib/aws-sqs');
    }

    if (hasSfnIntegrations) {
        addNsImport('sfn', 'aws-cdk-lib/aws-stepfunctions');
    }

    if (allApigwImports.size > 0) {
        if (
            !sourceFile.getImportDeclaration(
                d => d.getModuleSpecifierValue() === 'aws-cdk-lib/aws-apigateway'
            )
        ) {
            sourceFile.addImportDeclaration({
                namedImports: [...allApigwImports].sort(),
                moduleSpecifier: 'aws-cdk-lib/aws-apigateway',
            });
        }
    }

    addNamedImport(['Construct'], 'constructs');

    if (hasLambdaIntegrations) {
        if (
            !sourceFile.getImportDeclaration(
                d => d.getModuleSpecifierValue() === './lambda-functions.js'
            )
        ) {
            sourceFile.addImportDeclaration({
                namedImports: ['lambdaFunctions'],
                moduleSpecifier: './lambda-functions.js',
                isTypeOnly: true,
            });
        }
    }

    project.saveSync();
}
