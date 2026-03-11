import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SERVICE_GENERATION_COMMAND = 'npx nx g @aligent/nx-cdk:service';

/**
 * Generates a new CDK service in the destination workspace
 * using the @aligent/nx-cdk:service generator.
 *
 * Returns the path to the generated service directory, or throws on failure.
 */
export function generateCdkService(destination: string, serviceName: string): string {
    try {
        execSync(`${SERVICE_GENERATION_COMMAND} ${serviceName}`, {
            cwd: destination,
            stdio: 'inherit',
            timeout: 120_000,
        });

        return path.join(destination, 'services', serviceName);
    } catch {
        throw new Error(`Failed to generate CDK service "${serviceName}" in ${destination}.`);
    }
}

/**
 * Validates that the given directory is a valid @aligent/nx-cdk workspace
 * by running a dry-run service generation.
 */
export function validateCdkWorkspace(destination: string) {
    if (!fs.existsSync(destination)) {
        return new Error(`Destination directory does not exist: ${destination}`);
    }

    try {
        execSync(`${SERVICE_GENERATION_COMMAND} sls2cdk-validation --dry-run`, {
            cwd: destination,
            stdio: 'ignore',
            timeout: 60_000,
        });

        return null;
    } catch {
        return new Error(
            `Destination is not a valid @aligent/nx-cdk workspace: ${destination}. Ensure the directory is an Nx workspace with @aligent/nx-cdk installed.`
        );
    }
}
