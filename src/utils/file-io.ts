import * as fs from 'node:fs';
import * as path from 'node:path';

export function writeStepOutput(filePath: string, data: unknown) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Removes all generated -sub files (serverless-vars-substitution.yml + referenced file copies).
 */
export function cleanupSubFiles(subFiles: string[]) {
    subFiles.forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    });
}

export function createStepOutputDir(outputDir: string) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        return;
    }

    // remove all files in outputDir
    fs.readdirSync(outputDir).forEach(file => {
        fs.unlinkSync(path.join(outputDir, file));
    });
}
