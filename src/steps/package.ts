import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PackageResult {
    templatePath: string;
    serverlessDir: string;
}

export function runServerlessPackage(
    servicePath: string,
    stage: string,
    configFile?: string
): PackageResult {
    let command = `npx serverless@3.39.0 package --stage ${stage}`;
    if (configFile) {
        command += ` --config ${configFile}`;
    }

    try {
        execSync(command, {
            cwd: servicePath,
            stdio: 'inherit',
            timeout: 300_000,
        });
    } catch (error) {
        throw new Error(
            `serverless package failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    const serverlessDir = path.join(servicePath, '.serverless');
    const templatePath = path.join(serverlessDir, 'cloudformation-template-update-stack.json');

    if (!fs.existsSync(templatePath)) {
        throw new Error(
            `Expected CloudFormation template not found at: ${templatePath}. ` +
                'Ensure "serverless package" completed successfully.'
        );
    }

    return { templatePath, serverlessDir };
}
