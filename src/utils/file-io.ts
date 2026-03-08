import * as fs from 'node:fs';
import * as path from 'node:path';

export function writeStepOutput(filePath: string, data: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Copies the substituted yml files (serverless.yml + referenced files) into the output
 * directory so there is a snapshot of exactly what `serverless print` runs against.
 */
export function copySubstitutedFiles(
    serverlessYmlPath: string,
    modifiedFiles: string[],
    outputDir: string
): string[] {
    const snapshotDir = path.join(outputDir, 'substituted-files');
    fs.mkdirSync(snapshotDir, { recursive: true });

    const servicePath = path.dirname(serverlessYmlPath);
    const copiedFiles: string[] = [];

    for (const filePath of [serverlessYmlPath, ...modifiedFiles]) {
        const relPath = path.relative(servicePath, filePath);
        const destPath = path.join(snapshotDir, relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(filePath, destPath);
        copiedFiles.push(destPath);
    }

    return copiedFiles;
}
