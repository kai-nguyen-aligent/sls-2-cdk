import * as fs from 'node:fs';

export function writeStepOutput(filePath: string, data: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}
