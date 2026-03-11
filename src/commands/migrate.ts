import { confirm, input } from '@inquirer/prompts';
import { Command, Flags } from '@oclif/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildEnvMap } from '../steps/build-env-map.js';
import { runServerlessPackage } from '../steps/package.js';
import { substituteVariables } from '../steps/substitute-variables.js';
import { cleanupSubFiles, copySubstitutedFiles, writeStepOutput } from '../utils/file-io.js';
import { validateCdkWorkspace } from '../utils/workspace.js';

export default class Migrate extends Command {
    static override description =
        'Migrate Serverless Framework project(s) into CDK-ready artifacts by extracting and transforming the CloudFormation template.';

    static override examples = [
        '<%= config.bin %> migrate --intermediate ./intermediate',
        '<%= config.bin %> migrate -i ./monorepo',
        '<%= config.bin %> migrate -i ./monorepo -m ./out',
    ];

    static override flags = {
        input: Flags.directory({
            char: 'i',
            description:
                'Root directory to scan for Serverless Framework projects (finds all serverless.yml files recursively)',
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
                  message: 'Root directory to scan for Serverless Framework projects:',
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
        void keepNames; // FIXME: Will be consumed by downstream migration steps

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

        const projectPaths = this.discoverProjects(rootDir);
        if (projectPaths.length === 0) {
            this.error(`No serverless.yml or serverless.yaml found under ${rootDir}`, { exit: 1 });
        }

        fs.mkdirSync(intermediateDir, { recursive: true });

        this.log(`Root directory: ${rootDir}`);
        this.log(`Intermediate directory: ${intermediateDir}`);
        this.log(`Destination directory: ${destinationDir}`);
        this.log(`Projects found: ${projectPaths.length}`);
        this.log('---');

        for (const servicePath of projectPaths) {
            if (projectPaths.length > 1) {
                const projectName =
                    path.relative(rootDir, servicePath) || path.basename(servicePath);
                this.log(`\nProcessing project: ${projectName} (${servicePath})`);
                this.log('---');
            } else {
                this.log(`Converting Serverless project at: ${servicePath}`);
            }

            await this.processProject(servicePath, rootDir, intermediateDir);
        }

        this.log('\nAll projects processed.');
    }

    private async processProject(
        servicePath: string,
        rootDir: string,
        baseOutputDir: string
    ): Promise<void> {
        const serverlessYmlPath = this.findServerlessYml(servicePath);
        if (!serverlessYmlPath) {
            this.error(`No serverless.yml or serverless.yaml found in ${servicePath}`, { exit: 1 });
        }

        const relServicePath = path.relative(rootDir, servicePath);
        const snapshotDir = relServicePath
            ? path.join(baseOutputDir, relServicePath)
            : baseOutputDir;
        const stepOutputDir = path.join(snapshotDir, 'step-outputs');
        fs.mkdirSync(stepOutputDir, { recursive: true });

        let subFiles: string[] = [];
        try {
            this.log('Step 1/3: Substituting variables...');
            const varResult = this.runStep('01-substitute-variables', stepOutputDir, () =>
                substituteVariables(serverlessYmlPath)
            );
            subFiles = varResult.data.subFiles;

            copySubstitutedFiles(serverlessYmlPath, subFiles, baseOutputDir, rootDir);

            this.log('Step 2/3: Running serverless package...');
            const packageResult = this.runStep('02-package', stepOutputDir, () =>
                runServerlessPackage(servicePath, 'serverless-sub.yml')
            );
            const templateDest = path.join(stepOutputDir, 'cloudformation-template.json');
            fs.copyFileSync(packageResult.data.templatePath, templateDest);

            const template = JSON.parse(fs.readFileSync(templateDest, 'utf-8'));

            this.log('Step 3/3: Building Lambda environment variable map...');
            const envMapResult = this.runStep('03-env-map', stepOutputDir, () =>
                buildEnvMap(template)
            );

            // TODO: Generate new service for this migration

            // TODO: Copy folders & files to the destination. Provide options to skip this step
            // If it's folders, confirmation of the destination
            // If it's files (next to serverless.yml) -> place it in project root

            // TODO: map from resources to CDK construct & use ts-morph to write to destination file.

            // Summary
            this.log('---');
            this.log('Migration complete!');
            this.log(
                `  Var substitutions: ${varResult.data.count} (across ${subFiles.length} files)`
            );
            this.log(`  Lambda functions:  ${envMapResult.data.functionCount}`);
            this.log(`  Output files in:   ${snapshotDir}`);
        } finally {
            cleanupSubFiles(subFiles);
        }
    }

    private runStep<T>(
        stepName: string,
        outputDir: string,
        fn: () => T
    ): { data: T; durationMs: number } {
        const start = Date.now();
        try {
            const data = fn();
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

    private discoverProjects(rootDir: string): string[] {
        const matches = fs.globSync('**/serverless.{yml,yaml}', { cwd: rootDir });
        return matches.map(match => path.resolve(rootDir, path.dirname(match)));
    }

    private findServerlessYml(dir: string): string | null {
        for (const name of ['serverless.yml', 'serverless.yaml']) {
            const fullPath = path.join(dir, name);
            if (fs.existsSync(fullPath)) return fullPath;
        }
        return null;
    }
}
