import * as fs from 'node:fs';

export function writeStepOutput(filePath: string, data: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Removes all generated -sub files (serverless-vars-substitution.yml + referenced file copies).
 */
export function cleanupSubFiles(subFiles: string[]): void {
    subFiles.forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    });
}
