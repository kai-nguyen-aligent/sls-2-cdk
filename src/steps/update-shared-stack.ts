import * as fs from 'node:fs';

import { Node, Project, type ClassDeclaration, type SourceFile } from 'ts-morph';

import type {
    SsmParameter,
    UpdateSharedStackResult,
    VariableSubstitutions,
} from '../types/index.js';
import { generateCdkId } from '../utils/cfn-to-ts.js';

/**
 * Converts an SSM path to a camelCase JavaScript identifier.
 * Serverless variables like `${self:provider.stage}` are replaced with their last segment.
 * e.g. `/my-app/${self:provider.stage}/connection-url` → `myAppStageConnectionUrl`
 */
function ssmPathToIdentifier(ssmPath: string): string {
    const resolved = ssmPath.replace(/\$\{[^}]+\}/g, match => {
        const inner = match.slice(2, -1); // strip ${ and }
        return inner.split('.').pop() ?? inner;
    });

    const parts = resolved
        .split(/[/\-_.]+/)
        .filter(Boolean)
        .map(s => s.toLowerCase());

    if (parts.length === 0) return 'ssmParam';

    return parts
        .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join('');
}

/**
 * Extracts unique SSM parameters from the variable substitutions map.
 * Deduplicates by SSM path and generates stable camelCase identifiers.
 */
function extractSsmParameters(
    substitutions: VariableSubstitutions,
    servicePrefix: string
): SsmParameter[] {
    const seen = new Set<string>();
    const params: SsmParameter[] = [];

    for (const [expression, info] of Object.entries(substitutions)) {
        if (info.variableType !== 'ssm') continue;

        // Strip ${ssm:...} wrapper; handle optional default: ${ssm:/path, default}
        const inner = expression.slice('${ssm:'.length, -1);
        const ssmPath = inner.split(',')[0]!.trim();

        if (seen.has(ssmPath)) continue;
        seen.add(ssmPath);

        const identifier = ssmPathToIdentifier(ssmPath) || 'ssmParam';
        const cdkId = generateCdkId(
            identifier.charAt(0).toUpperCase() + identifier.slice(1),
            servicePrefix
        );
        const varName = cdkId.charAt(0).toLowerCase() + cdkId.slice(1);

        params.push({ expression, ssmPath, varName, cdkId });
    }

    // Resolve varName collisions by appending a numeric suffix
    const nameCounts = new Map<string, number>();
    return params.map(param => {
        const count = nameCounts.get(param.varName) ?? 0;
        nameCounts.set(param.varName, count + 1);
        if (count > 0) {
            const varName = `${param.varName}${count + 1}`;
            const cdkId = generateCdkId(
                varName.charAt(0).toUpperCase() + varName.slice(1),
                servicePrefix
            );
            return { ...param, varName, cdkId };
        }
        return param;
    });
}

/**
 * Ensures `IStringParameter` and `StringParameter` are imported from `aws-cdk-lib/aws-ssm`.
 */
function ensureSsmImports(sourceFile: SourceFile): void {
    const existing = sourceFile.getImportDeclaration(
        d => d.getModuleSpecifierValue() === 'aws-cdk-lib/aws-ssm'
    );
    const needed = ['IStringParameter', 'StringParameter'];
    if (!existing) {
        sourceFile.addImportDeclaration({
            namedImports: needed,
            moduleSpecifier: 'aws-cdk-lib/aws-ssm',
        });
        return;
    }
    const existingNames = existing.getNamedImports().map(n => n.getName());
    for (const name of needed) {
        if (!existingNames.includes(name)) {
            existing.addNamedImport(name);
        }
    }
}

/**
 * Adds new SSM properties to the interface, skipping any that already exist by name.
 */
function updateInterface(
    sourceFile: SourceFile,
    interfaceName: string,
    params: SsmParameter[]
): void {
    const iface = sourceFile.getInterface(interfaceName);
    if (!iface) return;

    const existingNames = new Set(iface.getProperties().map(p => p.getName()));
    const toAdd = params.filter(p => !existingNames.has(p.varName));

    for (let i = toAdd.length - 1; i >= 0; i--) {
        iface.insertProperty(0, { name: toAdd[i]!.varName, type: 'IStringParameter' });
    }
}

/**
 * Adds new SSM readonly properties to the class, skipping any that already exist by name.
 */
function updateClassProperties(stackClass: ClassDeclaration, params: SsmParameter[]): void {
    const existingNames = new Set(stackClass.getProperties().map(p => p.getName()));
    const toAdd = params.filter(p => !existingNames.has(p.varName));

    for (let i = toAdd.length - 1; i >= 0; i--) {
        stackClass.insertProperty(0, {
            name: toAdd[i]!.varName,
            type: 'IStringParameter',
            isReadonly: true,
        });
    }
}

const SECRETS_NOTE =
    '// TODO: [IMPORTANT] If any of these SSM values are secrets, convert them to AWS Secrets Manager instead.';

/**
 * Adds `StringParameter.fromStringParameterName(...)` assignments for each SSM param,
 * skipping any whose `param.ssmPath` already exists in the constructor body.
 * Also adds a one-time note about converting secrets to Secrets Manager if not already present.
 */
function updateConstructor(stackClass: ClassDeclaration, params: SsmParameter[]): void {
    const ctor = stackClass.getConstructors()[0];
    if (!ctor) return;

    const bodyText = ctor.getBody()?.getText() ?? '';
    const toAdd = params.filter(p => !bodyText.includes(p.ssmPath));

    if (toAdd.length === 0) return;

    if (!bodyText.includes(SECRETS_NOTE)) {
        ctor.addStatements(SECRETS_NOTE);
    }

    for (const param of toAdd) {
        ctor.addStatements(
            [
                `// SSM: ${param.expression}`,
                `this.${param.varName} = StringParameter.fromStringParameterName(`,
                `this,`,
                `'${param.cdkId}',`,
                `'${param.ssmPath}',`,
                `);`,
            ].join('\n')
        );
    }
}

/**
 * Adds new SSM entries to the `getProps()` return object, skipping any already present.
 */
function updateGetProps(stackClass: ClassDeclaration, params: SsmParameter[]): void {
    const method = stackClass.getMethod('getProps');
    if (!method) return;

    const returnStmt = method.getStatements().find(Node.isReturnStatement);
    if (!returnStmt) return;

    const returnText = returnStmt.getText();
    const toAdd = params.filter(p => !returnText.includes(p.varName));
    if (toAdd.length === 0) return;

    // Insert new entries before the closing `};`
    const closingIdx = returnText.lastIndexOf('};');
    if (closingIdx === -1) return;

    const newEntries = toAdd.map(p => `${p.varName}: this.${p.varName},`).join('\n');
    returnStmt.replaceWithText(returnText.slice(0, closingIdx) + newEntries + '\n};');
}

/**
 * Updates the shared infra stack (`libs/infra/src/index.ts`) in the destination CDK workspace:
 *
 * 1. Collects all SSM variable references from the Serverless substitutions.
 * 2. Inserts new `IStringParameter` properties into the `SharedInfraProps` interface
 *    and class, commenting out the existing example properties.
 * 3. Replaces example `this.xxx` constructor assignments with
 *    `StringParameter.fromStringParameterName(...)` calls for each SSM path.
 * 4. Updates `getProps()` to return the new SSM parameters.
 */
export function updateSharedStack(
    substitutions: VariableSubstitutions,
    outputPath: string,
    servicePrefix: string
): UpdateSharedStackResult {
    if (!fs.existsSync(outputPath)) {
        throw new Error(`Shared stack file not found: ${outputPath}`);
    }

    const ssmParameters = extractSsmParameters(substitutions, servicePrefix);

    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(outputPath);

    if (ssmParameters.length > 0) {
        ensureSsmImports(sourceFile);
    }

    const stackClass = sourceFile.getClasses()[0];
    if (!stackClass) {
        throw new Error('No class found in shared stack file');
    }

    // Derive the interface name from the getProps() return type annotation
    const getPropsMethod = stackClass.getMethod('getProps');
    const interfaceName = getPropsMethod?.getReturnTypeNode()?.getText() ?? 'SharedInfraProps';

    updateInterface(sourceFile, interfaceName, ssmParameters);
    updateClassProperties(stackClass, ssmParameters);
    updateConstructor(stackClass, ssmParameters);
    updateGetProps(stackClass, ssmParameters);

    project.saveSync();

    return {
        outputPath,
        ssmParameters,
        ssmCount: ssmParameters.length,
    };
}
