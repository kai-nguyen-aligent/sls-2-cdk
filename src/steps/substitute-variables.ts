import * as fs from 'node:fs';
import * as path from 'node:path';

interface VarMatch {
    start: number;
    end: number;
    fullMatch: string;
}

export interface VariableSubstitution {
    original: string;
    placeholder: string;
    filePath: string;
}

export interface SubstituteVariablesResult {
    substitutions: VariableSubstitution[];
    count: number;
    filesModified: string[];
}

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
 * Finds files referenced via ${file(...)} in serverless.yml and substitutes all ${...}
 * variable references in those files with traceable placeholders (__SLS2CDK_VAR_N__).
 *
 * This prevents `serverless print` from trying to resolve variables (e.g. SSM, env, cf)
 * inside referenced files, while still allowing the file include itself to be resolved.
 */
export function substituteVariables(serverlessYmlPath: string): SubstituteVariablesResult {
    const serverlessDir = path.dirname(serverlessYmlPath);
    const content = fs.readFileSync(serverlessYmlPath, 'utf-8');

    const referencedFiles = findFileReferences(content, serverlessDir);
    const substitutions: VariableSubstitution[] = [];
    const filesModified: string[] = [];
    let placeholderIndex = 0;

    for (const filePath of referencedFiles) {
        if (!fs.existsSync(filePath)) continue;

        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const refs = findVariableReferences(fileContent);
        if (refs.length === 0) continue;

        // Back up the file before modifying
        const backupPath = filePath + '.sls2cdk.bak';
        if (!fs.existsSync(backupPath)) {
            fs.copyFileSync(filePath, backupPath);
        }

        // Replace from end to start to preserve string indices
        let modified = fileContent;
        for (let i = refs.length - 1; i >= 0; i--) {
            const ref = refs[i]!;
            const placeholder = `__SLS2CDK_VAR_${placeholderIndex}__`;
            substitutions.push({
                original: ref.fullMatch,
                placeholder,
                filePath,
            });
            modified = modified.slice(0, ref.start) + placeholder + modified.slice(ref.end);
            placeholderIndex++;
        }

        fs.writeFileSync(filePath, modified);
        filesModified.push(filePath);
    }

    return {
        substitutions,
        count: substitutions.length,
        filesModified,
    };
}

/**
 * Restores all referenced files that were modified during variable substitution.
 */
export function restoreReferencedFiles(filePaths: string[]): void {
    for (const filePath of filePaths) {
        const backupPath = filePath + '.sls2cdk.bak';
        if (fs.existsSync(backupPath)) {
            fs.copyFileSync(backupPath, filePath);
            fs.unlinkSync(backupPath);
        }
    }
}
