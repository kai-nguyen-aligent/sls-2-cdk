import * as fs from 'node:fs';
import * as path from 'node:path';

import { stringify } from 'yaml';

import type {
    CloudFormationTemplate,
    ExtractStateMachineDefinitionsResult,
    ResourceEntry,
    StateMachineDefinitionInfo,
    StateMachineSubstitution,
} from '../../types/index.js';
import { generateCdkId, pascalToCamel, RawTs, valueToTs } from '../cfn-to-ts.js';

/**
 * Derives a filesystem-safe YAML filename from a CloudFormation StateMachine resource.
 * Prefers the StateMachineName property; falls back to the logical ID.
 */
function deriveYamlFileName(logicalId: string, properties: Record<string, unknown>): string {
    const stateMachineName = properties['StateMachineName'];
    const base = typeof stateMachineName === 'string' ? stateMachineName : logicalId;

    return base
        .replace(/__SLS2CDK_[A-Z]+_[a-f0-9]+__/g, '')
        .replace(/[^a-zA-Z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

/**
 * Extracts Step Function ASL definitions from CloudFormation StateMachine resources,
 * converts them to YAML, and writes them to the destination service directory.
 *
 * Only handles the Fn::Sub array form of DefinitionString. Resources using other
 * forms are skipped.
 */
export function extractStateMachineDefinitions(
    template: CloudFormationTemplate,
    destinationServicePath: string
): ExtractStateMachineDefinitionsResult {
    const definitions: Record<string, StateMachineDefinitionInfo> = {};

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (resource.Type !== 'AWS::StepFunctions::StateMachine') continue;

        const props = resource.Properties ?? {};
        const definitionString = props['DefinitionString'];

        const fnSub = (definitionString as Record<string, unknown> | undefined)?.['Fn::Sub'];
        if (!Array.isArray(fnSub) || fnSub.length !== 2) continue;

        const [aslTemplate, subMap] = fnSub as [string, Record<string, unknown>];
        if (typeof aslTemplate !== 'string' || typeof subMap !== 'object' || subMap === null) {
            continue;
        }

        const substitutions: StateMachineSubstitution[] = [];
        let resolvedAsl = aslTemplate;

        for (const [hash, cfnRef] of Object.entries(subMap)) {
            const getAtt = (cfnRef as Record<string, unknown>)['Fn::GetAtt'];
            if (!Array.isArray(getAtt) || getAtt.length !== 2) continue;

            const [refLogicalId] = getAtt as [string, string];
            const refResource = template.Resources[refLogicalId];
            const isLambda = refResource?.Type === 'AWS::Lambda::Function';

            const cdkId = generateCdkId(refLogicalId);
            const cdkVarName = pascalToCamel(cdkId);

            resolvedAsl = resolvedAsl.replaceAll(`\${${hash}}`, `\${${cdkVarName}}`);
            substitutions.push({ cdkVarName, refLogicalId, isLambda });
        }

        const aslObj = JSON.parse(resolvedAsl) as unknown;
        const aslYaml = stringify(aslObj);

        const outputDir = path.join(destinationServicePath, 'src', 'infra', 'step-functions');
        fs.mkdirSync(outputDir, { recursive: true });

        const fileName = deriveYamlFileName(logicalId, props);
        const yamlPath = path.join(outputDir, `${fileName}.asl.yaml`);
        fs.writeFileSync(yamlPath, aslYaml, 'utf-8');

        definitions[logicalId] = { yamlPath, substitutions };
    }

    return { definitions, count: Object.keys(definitions).length };
}

export function buildStateMachineStatement(
    entry: ResourceEntry,
    definitionInfo: StateMachineDefinitionInfo | undefined,
    sourceFilePath: string
): string {
    const { cdkId } = entry.logicalId;
    const varName = pascalToCamel(cdkId);

    const props = { ...entry.properties };

    if (definitionInfo) {
        const sourceDir = path.dirname(sourceFilePath);
        const relYamlPath = path.relative(sourceDir, definitionInfo.yamlPath).replace(/\\/g, '/');
        props['filepath'] = relYamlPath;

        const lambdaSubs = definitionInfo.substitutions.filter(s => s.isLambda);
        if (lambdaSubs.length > 0) {
            const lambdaEntries = lambdaSubs.map(s => `${s.cdkVarName}`).join(',');
            props['lambdaFunctions'] = new RawTs(`[${lambdaEntries}]`);
        }

        const nonLambdaSubs = definitionInfo.substitutions.filter(s => !s.isLambda);
        if (nonLambdaSubs.length > 0) {
            const subEntries = nonLambdaSubs
                .map(s => `${s.cdkVarName}: '', ` + `// TODO: replace with correct CDK expression`)
                .join('\n');
            props['definitionSubstitutions'] = new RawTs(`{${subEntries}}`);
        }
    } else {
        props['filepath'] = new RawTs(
            `'', + '// FIXME: DefinitionString was not Fn::Sub — provide filepath, lambdaFunctions, & definitionSubstitutions manually'`
        );
    }

    const allProps = valueToTs(props);

    return (
        `const ${varName} = new ${entry.mapping.importAlias}.${entry.mapping.className}` +
        `(this, '${cdkId}', ${allProps});`
    );
}
