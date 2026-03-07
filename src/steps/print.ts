import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

export interface ServerlessPrintResult {
    resolvedYaml: string;
}

export function runServerlessPrint(
    servicePath: string,
    serverlessYmlPath: string,
    stage: string
): ServerlessPrintResult {
    // Back up the original serverless.yml before modifying it
    const backupPath = serverlessYmlPath + '.sls2cdk.bak';
    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(serverlessYmlPath, backupPath);
    }

    let resolvedYaml: string;
    try {
        resolvedYaml = execSync(`npx serverless@3.39.0 print --stage ${stage}`, {
            cwd: servicePath,
            encoding: 'utf-8',
            timeout: 300_000,
        });
    } catch (error) {
        throw new Error(
            `serverless print failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    // Write the resolved YAML back to serverless.yml for subsequent steps
    fs.writeFileSync(serverlessYmlPath, resolvedYaml);

    return { resolvedYaml };
}
