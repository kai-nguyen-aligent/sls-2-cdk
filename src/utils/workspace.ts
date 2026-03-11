import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

const DRY_RUN_SERVICE_NAME = 'test-sls2cdk-validation';

/**
 * Validates that the given directory is a valid @aligent/nx-cdk workspace
 * by running a dry-run service generation.
 */
export function validateCdkWorkspace(destination: string) {
    if (!fs.existsSync(destination)) {
        return new Error(`Destination directory does not exist: ${destination}`);
    }

    try {
        execSync(`npx nx g @aligent/nx-cdk:service ${DRY_RUN_SERVICE_NAME} --dry-run`, {
            cwd: destination,
            stdio: 'ignore',
            timeout: 60_000,
        });

        return null;
    } catch {
        return new Error(
            `Destination is not a valid @aligent/nx-cdk workspace: ${destination}. ` +
                'Ensure the directory is an Nx workspace with @aligent/nx-cdk installed.'
        );
    }
}
