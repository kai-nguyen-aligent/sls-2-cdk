import { confirm, input } from '@inquirer/prompts';
import { Command, Flags } from '@oclif/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildEnvMap } from '../steps/build-env-map.js';
import { buildResourceMap } from '../steps/build-resource-map.js';
import { runServerlessPackage } from '../steps/package.js';
import { runServerlessPrint } from '../steps/print.js';
import { removeResources } from '../steps/remove-resources.js';
import { restoreServerlessYml, substituteSSM } from '../steps/substitute-ssm.js';
import { restoreReferencedFiles, substituteVariables } from '../steps/substitute-variables.js';
import type { Sls2CdkConfig } from '../types/index.js';
import { loadConfig } from '../utils/config.js';
import { copySubstitutedFiles, writeStepOutput } from '../utils/file-io.js';

export default class Convert extends Command {
    static override description =
        'Convert Serverless Framework project(s) into CDK-ready artifacts by extracting and transforming the CloudFormation template.';

    static override examples = [
        '<%= config.bin %> convert --intermediate ./intermediate',
        '<%= config.bin %> convert --stage prod --config ./sls-2-cdk.config.json',
        '<%= config.bin %> convert -i ./monorepo -m ./out',
    ];

    static override flags = {
        config: Flags.file({
            char: 'c',
            description: 'Path to config file specifying resources to remove',
            exists: true,
        }),
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

        stage: Flags.string({
            char: 's',
            description: 'Stage name for serverless package',
            default: 'dev',
        }),
    };

    async run(): Promise<void> {
        const { flags, metadata } = await this.parse(Convert);

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
        const outputDir = path.resolve(rootDir, intermediate);

        const stage = metadata.flags.stage?.setFromDefault
            ? await input({
                  message: 'Stage name for serverless package:',
                  default: flags.stage,
              })
            : flags.stage;

        let configPath = flags.config;
        if (!configPath) {
            const wantsConfig = await confirm({
                message: 'Do you want to provide a config file for resource removal?',
                default: false,
            });
            if (wantsConfig) {
                configPath = await input({ message: 'Path to config file:' });
            }
        }

        const config = loadConfig(configPath);

        // Discover all serverless.yml/yaml files under the root directory
        const projectPaths = this.discoverProjects(rootDir);
        if (projectPaths.length === 0) {
            this.error(`No serverless.yml or serverless.yaml found under ${rootDir}`, { exit: 1 });
        }

        const isMultiProject = projectPaths.length > 1;

        fs.mkdirSync(outputDir, { recursive: true });

        this.log(`Root directory: ${rootDir}`);
        this.log(`Intermediate directory: ${outputDir}`);
        this.log(`Stage: ${stage}`);
        this.log(`Projects found: ${projectPaths.length}`);
        this.log('---');

        for (const servicePath of projectPaths) {
            const projectName = path.relative(rootDir, servicePath) || path.basename(servicePath);
            const projectOutputDir = isMultiProject ? path.join(outputDir, projectName) : outputDir;

            if (isMultiProject) {
                fs.mkdirSync(projectOutputDir, { recursive: true });
                this.log(`\nProcessing project: ${projectName} (${servicePath})`);
                this.log('---');
            } else {
                this.log(`Converting Serverless project at: ${servicePath}`);
            }

            await this.processProject(servicePath, projectOutputDir, stage, config);
        }

        this.log('\nAll projects processed.');
    }

    private async processProject(
        servicePath: string,
        outputDir: string,
        stage: string,
        config: Sls2CdkConfig
    ): Promise<void> {
        const serverlessYmlPath = this.findServerlessYml(servicePath);
        if (!serverlessYmlPath) {
            this.error(`No serverless.yml or serverless.yaml found in ${servicePath}`, { exit: 1 });
        }

        let modifiedFiles: string[] = [];
        try {
            this.log('Step 1/7: Substituting variables in referenced files...');
            const varResult = this.runStep('01-substitute-variables', outputDir, () =>
                substituteVariables(serverlessYmlPath)
            );
            modifiedFiles = varResult.data.filesModified;

            this.log('Step 2/7: Substituting SSM parameters...');
            const ssmResult = this.runStep('02-ssm-substitution', outputDir, () =>
                substituteSSM(serverlessYmlPath)
            );

            copySubstitutedFiles(serverlessYmlPath, modifiedFiles, outputDir);

            this.log('Step 3/7: Resolving serverless configuration...');
            this.runStep('03-serverless-print', outputDir, () =>
                runServerlessPrint(servicePath, serverlessYmlPath, stage)
            );

            this.log('Step 4/7: Running serverless package...');
            const packageResult = this.runStep('04-package', outputDir, () =>
                runServerlessPackage(servicePath, stage)
            );

            this.log('Step 5/7: Removing Serverless-specific resources...');
            const templatePath = packageResult.data.templatePath;
            const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
            const removeResult = this.runStep('05-remove-resources', outputDir, () =>
                removeResources(template, config)
            );

            this.log('Step 6/7: Building resource map...');
            const resourceMapResult = this.runStep('06-resource-map', outputDir, () =>
                buildResourceMap(removeResult.data.template)
            );

            this.log('Step 7/7: Building Lambda environment variable map...');
            const envMapResult = this.runStep('07-env-map', outputDir, () =>
                buildEnvMap(removeResult.data.template)
            );

            // Summary
            this.log('---');
            this.log('Conversion complete!');
            this.log(
                `  Var substitutions: ${varResult.data.count} (across ${modifiedFiles.length} files)`
            );
            this.log(`  SSM substitutions: ${ssmResult.data.count}`);
            this.log(`  Resources removed: ${removeResult.data.removed.length}`);
            this.log(`  Resources mapped:  ${resourceMapResult.data.totalCount}`);
            this.log(`  Lambda functions:  ${envMapResult.data.functionCount}`);
            this.log(`  Output files in:   ${outputDir}`);
        } finally {
            restoreReferencedFiles(modifiedFiles);
            restoreServerlessYml(serverlessYmlPath);
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
