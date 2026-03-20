import { confirm, input } from '@inquirer/prompts';
import { Command, Flags } from '@oclif/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildEnvMap } from '../steps/build-env-map.js';
import { extractStateMachineDefinitions } from '../steps/extract-state-machine-definitions.js';
import { generateConstructs } from '../steps/generate-constructs.js';
import { migrateRuntimeCode } from '../steps/migrate-runtime-code.js';
import { runServerlessPackage } from '../steps/package.js';
import { substituteVariables } from '../steps/substitute-variables.js';
import { updateSharedStack } from '../steps/update-shared-stack.js';
import { cleanupSubFiles, writeStepOutput } from '../utils/file-io.js';
import { generateCdkService, validateCdkWorkspace } from '../utils/workspace.js';

export default class Migrate extends Command {
    static override description =
        'Migrate a Serverless Framework project into CDK-ready artifacts by extracting and transforming the CloudFormation template.';

    static override examples = [
        '<%= config.bin %> migrate',
        '<%= config.bin %> migrate -i ./my-service',
        '<%= config.bin %> migrate -i ./my-service -m ./intermediate',
    ];

    static override flags = {
        input: Flags.directory({
            char: 'i',
            description:
                'Directory containing the Serverless Framework project (must have exactly one serverless.yml or serverless.yaml)',
            default: '.',
        }),
        intermediate: Flags.directory({
            char: 'm',
            description:
                'Directory for intermediate JSON files (default: .sls-2-cdk inside the input directory)',
            default: '.sls-2-cdk',
        }),
        'keep-names': Flags.boolean({
            char: 'k',
            description:
                'Keep original resource names (e.g. S3 bucket names, DynamoDB table names) during migration',
            default: false,
        }),
        destination: Flags.directory({
            char: 'd',
            description: 'Destination CDK workspace directory (bootstrapped with @aligent/nx-cdk)',
        }),
    };

    async run(): Promise<void> {
        this.log('');
        this.log('=== sls-2-cdk: Serverless Framework to CDK Migration ===');
        this.log('');
        this.log('Prerequisites:');
        this.log('  The destination workspace must be created with @aligent/nx-cdk:preset');
        this.log('  If you have not set one up yet, run: npx @aligent/create-workspace');
        this.log('');

        const { flags, metadata } = await this.parse(Migrate);

        const inputDir = metadata.flags.input?.setFromDefault
            ? await input({
                  message: 'Directory containing the Serverless Framework project:',
                  default: flags.input,
              })
            : flags.input;
        const rootDir = path.resolve(inputDir);

        const intermediate = metadata.flags.intermediate?.setFromDefault
            ? await input({
                  message: 'Directory for intermediate JSON files:',
                  default: flags.intermediate,
              })
            : flags.intermediate;
        const intermediateDir = path.resolve(rootDir, intermediate);

        const keepNames = metadata.flags['keep-names']?.setFromDefault
            ? await confirm({
                  message: 'Keep original resource names during migration?',
                  default: flags['keep-names'],
              })
            : flags['keep-names'];

        const destinationDir = flags.destination
            ? path.resolve(flags.destination)
            : path.resolve(
                  await input({
                      message:
                          'Destination CDK workspace directory (bootstrapped with @aligent/nx-cdk):',
                  })
              );

        const error = validateCdkWorkspace(destinationDir);
        if (error) {
            this.error(String(error), { exit: 1 });
        }

        this.log(`Input directory: ${rootDir}`);
        this.log(`Intermediate directory: ${intermediateDir}`);
        this.log(`Destination directory: ${destinationDir}`);
        this.log('---');

        const serverlessYmlPath = this.discoverProject(rootDir);
        this.log(`Migration Serverless project at: ${serverlessYmlPath}`);

        fs.mkdirSync(intermediateDir, { recursive: true });

        await this.processProject(
            serverlessYmlPath,
            rootDir,
            intermediateDir,
            destinationDir,
            keepNames
        );

        this.log('\nServerless project migrated.');
    }

    private async processProject(
        serverlessYmlPath: string,
        rootDir: string,
        intermediateDir: string,
        destinationDir: string,
        keepNames: boolean
    ): Promise<void> {
        const servicePath = path.dirname(serverlessYmlPath);
        const relServicePath = path.relative(rootDir, servicePath);
        const snapshotDir = relServicePath
            ? path.join(intermediateDir, relServicePath)
            : intermediateDir;
        const stepOutputDir = path.join(snapshotDir, 'step-outputs');
        // TODO: remove stepOutputDir if exist, create if not, move to util/file-io.ts
        fs.mkdirSync(stepOutputDir, { recursive: true });

        this.log('Step 1: Substituting variables...');
        const varResult = await this.runStep('01-substitute-variables', stepOutputDir, () =>
            substituteVariables(serverlessYmlPath)
        );

        this.log('Step 2: Running serverless package...');
        const packageResult = await this.runStep('02-serverless-package', stepOutputDir, () =>
            runServerlessPackage(servicePath, 'serverless-vars-substitution.yml')
        );
        const templateDest = path.join(stepOutputDir, 'cloudformation-template.json');
        fs.copyFileSync(packageResult.data.templatePath, templateDest);

        const template = JSON.parse(fs.readFileSync(templateDest, 'utf-8'));

        this.log('Step 3: Building Lambda environment variable map...');
        const envMapResult = await this.runStep('03-env-map', stepOutputDir, () =>
            buildEnvMap(template)
        );

        this.log('Step 4: Updating shared stack with SSM parameters...');
        await this.runStep('04-update-shared-stack', stepOutputDir, () =>
            updateSharedStack(
                varResult.data.substitutions,
                path.join(destinationDir, 'libs', 'infra', 'src', 'index.ts')
            )
        );

        this.log('Step 5: Generating destination CDK service...');
        const genResult = await this.runStep('05-generate-dest-service', stepOutputDir, () =>
            generateCdkService(destinationDir, path.basename(servicePath))
        );

        this.log('Step 6: Extracting Step Function definitions...');
        const smResult = await this.runStep(
            '06-extract-state-machine-definitions',
            stepOutputDir,
            () => extractStateMachineDefinitions(template, genResult.data)
        );

        this.log('Step 7: Generating CDK constructs...');
        const constructResult = await this.runStep('07-generate-constructs', stepOutputDir, () =>
            generateConstructs(
                template,
                keepNames,
                genResult.data,
                smResult.data.definitions,
                envMapResult.data.sharedVariables
            )
        );

        this.log('Step 8: Migrating runtime code...');
        await this.runStep('08-migrate-runtime-code', stepOutputDir, () =>
            migrateRuntimeCode(servicePath, genResult.data)
        );

        // TODO: As user if they want to remove sub files
        cleanupSubFiles(varResult.data.subFiles);

        // Summary
        this.log('---');
        this.log('Migration complete!');
        this.log(
            `  Var substitutions: ${varResult.data.count} (across ${varResult.data.subFiles.length} files)`
        );
        this.log(`  Lambda functions:  ${envMapResult.data.functionCount}`);
        this.log(`  Step Functions:    ${smResult.data.count} definitions extracted`);
        this.log(
            `  CDK constructs:    ${constructResult.data.generatedCount} generated, ${constructResult.data.skippedCount} skipped`
        );
        this.log(`  Intermediate output files in:   ${intermediateDir}`);
        // TODO: next step after migration
    }

    private async runStep<T>(
        stepName: string,
        outputDir: string,
        fn: () => T | Promise<T>
    ): Promise<{ data: T; durationMs: number }> {
        const start = Date.now();
        try {
            const data = await fn();
            const durationMs = Date.now() - start;
            const outputFile = path.join(outputDir, `${stepName}.json`);
            writeStepOutput(outputFile, { stepName, success: true, data, durationMs });
            this.log(`  Done (${durationMs}ms) -> ${outputFile}`);
            return { data, durationMs };
        } catch (error) {
            const durationMs = Date.now() - start;
            const message = error instanceof Error ? error.message : String(error);
            const outputFile = path.join(outputDir, `${stepName}.json`);
            writeStepOutput(outputFile, {
                stepName,
                success: false,
                data: null,
                durationMs,
                error: message,
            });
            this.error(`Step "${stepName}" failed: ${message}`, { exit: 1 });
        }
    }

    private discoverProject(rootDir: string): string {
        const matches = fs.globSync('serverless.{yml,yaml}', { cwd: rootDir });
        if (matches.length !== 1) {
            this.error(
                `Multiple serverless config files found in ${rootDir}: ${matches.join(', ')}`,
                { exit: 1 }
            );
        }

        return path.resolve(rootDir, matches[0]!);
    }
}
