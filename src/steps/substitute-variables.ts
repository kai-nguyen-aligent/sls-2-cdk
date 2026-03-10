import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseDocument, visit } from 'yaml';

import type {
    SubstituteVariablesResult,
    VariableSubstitutions,
    VariableType,
} from '../types/index.js';

interface VarMatch {
    start: number;
    end: number;
    fullMatch: string;
}

/** Known Serverless Framework variable prefixes that require external resolution */
const EXTERNAL_VARIABLE_PREFIXES = ['ssm', 's3:', 'cf:', 'env:', 'aws:'];

/**
 * Finds all ${...} variable references in content, handling nested ${} by counting brace depth.
 */
function findVariableReferences(content: string): VarMatch[] {
    const results: VarMatch[] = [];
    const marker = '${';
    let searchFrom = 0;

    while (searchFrom < content.length) {
        const idx = content.indexOf(marker, searchFrom);
        if (idx === -1) break;

        let depth = 0;
        let endIdx = -1;
        for (let i = idx; i < content.length; i++) {
            if (content[i] === '{') depth++;
            if (content[i] === '}') {
                depth--;
                if (depth === 0) {
                    endIdx = i;
                    break;
                }
            }
        }

        if (endIdx !== -1) {
            results.push({
                start: idx,
                end: endIdx + 1,
                fullMatch: content.slice(idx, endIdx + 1),
            });
            searchFrom = endIdx + 1;
        } else {
            searchFrom = idx + marker.length;
        }
    }

    return results;
}

/**
 * Extracts unique file paths from ${file(...)} references in serverless.yml content.
 */
function findFileReferences(content: string, baseDir: string): string[] {
    const filePaths = new Set<string>();
    const regex = /\$\{file\(([^)]+)\)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        const relPath = match[1]!;
        const absPath = path.resolve(baseDir, relPath);
        filePaths.add(absPath);
    }
    return [...filePaths];
}

/**
 * Determines if a variable reference is one that Serverless Framework would try
 * to resolve externally (SSM, S3, CloudFormation, env vars, AWS account info).
 */
function shouldSubstitute(expression: string): boolean {
    const inner = expression.slice(2, -1);
    return EXTERNAL_VARIABLE_PREFIXES.some(prefix => inner.startsWith(prefix));
}

/**
 * Determines the type of a Serverless Framework variable reference.
 */
function classifyVariableType(expression: string): VariableType {
    const inner = expression.slice(2, -1);
    if (inner.startsWith('ssm')) return 'ssm';
    if (inner.startsWith('s3:')) return 's3';
    if (inner.startsWith('cf:') || inner.startsWith('cf.')) return 'cf';
    if (inner.startsWith('env:')) return 'env';
    if (inner.startsWith('aws:')) return 'aws';
    return 'ignore';
}

/**
 * Generates the -sub file path by inserting '-sub' before the file extension.
 * e.g., ./env.json → ./env-sub.json, ./config.yml → ./config-sub.yml
 */
function getSubPath(filePath: string): string {
    const ext = path.extname(filePath);
    const base = filePath.slice(0, -ext.length || undefined);
    return `${base}-sub${ext}`;
}

/**
 * Checks if a ${file(...)} reference points to a file that was processed
 * (i.e., has a -sub copy). If so, returns the rewritten expression with
 * the -sub path. Otherwise returns null.
 */
function rewriteFileReference(
    expression: string,
    serverlessDir: string,
    filePathMap: Map<string, string>
): string | null {
    const inner = expression.slice(2, -1); // strip ${ and }
    if (!inner.startsWith('file(')) return null;

    // Extract the file path from file(path) or file(path):key
    const fileMatch = inner.match(/^file\(([^)]+)\)/);
    if (!fileMatch) return null;

    const relPath = fileMatch[1]!;
    const absPath = path.resolve(serverlessDir, relPath);
    const subAbsPath = filePathMap.get(absPath);
    if (!subAbsPath) return null;

    // Build the relative sub path from the serverless dir
    const subRelPath = path.relative(serverlessDir, subAbsPath);
    // Preserve the rest of the expression after file(path), e.g., ":key"
    const suffix = inner.slice(fileMatch[0].length);
    return `\${file(${subRelPath})${suffix}}`;
}

/**
 * Substitutes ${...} variable references within a single string value.
 * Only external variables are substituted, ${file(...)} paths are rewritten,
 * and local vars (self, sls, opt) are preserved.
 */
function substituteScalarValue(
    value: string,
    serverlessDir: string,
    filePathMap: Map<string, string>,
    substitutions: VariableSubstitutions
): string {
    const refs = findVariableReferences(value);
    if (refs.length === 0) return value;

    let modified = value;

    // Process from end to start to preserve string indices
    for (let i = refs.length - 1; i >= 0; i--) {
        const ref = refs[i]!;

        // Check if this is a ${file(...)} reference that needs path rewriting
        const rewritten = rewriteFileReference(ref.fullMatch, serverlessDir, filePathMap);
        if (rewritten) {
            modified = modified.slice(0, ref.start) + rewritten + modified.slice(ref.end);
            continue;
        }

        // Check if this is an external variable that should be substituted
        if (shouldSubstitute(ref.fullMatch)) {
            let placeholder = `__SLS2CDK_VAR_${ref.fullMatch.toUpperCase()}__`;
            const existing = substitutions[ref.fullMatch];
            if (existing) {
                substitutions[ref.fullMatch] = { ...existing, count: existing.count + 1 };
                placeholder = existing.placeholder;
            } else {
                substitutions[ref.fullMatch] = {
                    placeholder,
                    count: 1,
                    variableType: classifyVariableType(ref.fullMatch),
                };
            }

            modified = modified.slice(0, ref.start) + placeholder + modified.slice(ref.end);
        }

        // Otherwise (self:, sls:, opt:, file() without sub, unknown patterns) — keep as-is
    }

    return modified;
}

/**
 * Walks all scalar values in a YAML document, substituting external variables
 * and rewriting ${file(...)} paths. Skips CloudFormation !Sub tagged values.
 */
function substituteDocumentVariables(
    doc: ReturnType<typeof parseDocument>,
    serverlessDir: string,
    filePathMap: Map<string, string>,
    substitutions: VariableSubstitutions
): void {
    visit(doc, {
        Scalar(_key, node) {
            if (typeof node.value !== 'string') return;
            if (node.tag === '!Sub') return;

            const original = node.value;
            const modified = substituteScalarValue(
                original,
                serverlessDir,
                filePathMap,
                substitutions
            );

            if (modified !== original) {
                node.value = modified;
            }
        },
    });
}

/**
 * Serializes a YAML document to string, preserving the original trailing newline behavior.
 */
function serializeDocument(doc: ReturnType<typeof parseDocument>, originalContent: string): string {
    let output = doc.toString({ lineWidth: 0 });
    if (!originalContent.endsWith('\n') && output.endsWith('\n')) {
        output = output.slice(0, -1);
    }
    return output;
}

/**
 * Finds files referenced via ${file(...)} in serverless.yml and substitutes
 * external ${...} variable references across both referenced files and serverless.yml.
 *
 * - Referenced files: Only YAML files (.yml, .yaml) are supported. Parsed as YAML
 *   documents with only external variables (ssm, s3, cf, env, aws) substituted.
 *   ${self:...}, ${sls:...}, ${opt:...} are left intact. CloudFormation !Sub tagged
 *   values are skipped. New -sub copies are created. Non-YAML files are ignored.
 * - serverless.yml: Parsed as a YAML document. Only external variables (ssm, s3, cf,
 *   env, aws) are substituted. ${file(...)} paths are rewritten to point to -sub copies.
 *   ${self:...}, ${sls:...}, ${opt:...} are left intact. CloudFormation !Sub tagged
 *   values are skipped entirely. Result is written to serverless-sub.yml.
 *
 * No original files are modified.
 */
export function substituteVariables(serverlessYmlPath: string): SubstituteVariablesResult {
    const serverlessDir = path.dirname(serverlessYmlPath);
    const content = fs.readFileSync(serverlessYmlPath, 'utf-8');

    const substitutions: VariableSubstitutions = {};
    const subFiles: string[] = [];

    // --- Part 1: Create -sub copies of referenced YAML files with external variables substituted ---
    const referencedFiles = findFileReferences(content, serverlessDir);
    const filePathMap = new Map<string, string>(); // original abs path → sub abs path
    const yamlExtensions = new Set(['.yml', '.yaml']);

    for (const filePath of referencedFiles) {
        if (!fs.existsSync(filePath)) continue;

        // Only YAML files are supported for variable substitution
        if (!yamlExtensions.has(path.extname(filePath).toLowerCase())) continue;

        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const fileDoc = parseDocument(fileContent);
        substituteDocumentVariables(fileDoc, serverlessDir, filePathMap, substitutions);

        const subPath = getSubPath(filePath);
        fs.writeFileSync(subPath, serializeDocument(fileDoc, fileContent));
        subFiles.push(subPath);
        filePathMap.set(filePath, subPath);
    }

    // --- Part 2: Parse serverless.yml as YAML and substitute variables in scalar values ---
    const doc = parseDocument(content);
    substituteDocumentVariables(doc, serverlessDir, filePathMap, substitutions);

    const serverlessSubPath = path.join(serverlessDir, 'serverless-sub.yml');
    fs.writeFileSync(serverlessSubPath, serializeDocument(doc, content));
    subFiles.push(serverlessSubPath);

    return {
        substitutions,
        count: Object.keys(substitutions).length,
        subFiles,
        serverlessSubPath,
    };
}
