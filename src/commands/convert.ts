import { Command, Flags } from '@oclif/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildEnvMap } from '../steps/build-env-map.js';
import { buildResourceMap } from '../steps/build-resource-map.js';
import { runServerlessPackage } from '../steps/package.js';
import { removeResources } from '../steps/remove-resources.js';
import { restoreServerlessYml, substituteSSM } from '../steps/substitute-ssm.js';
import type { Sls2CdkConfig } from '../types/index.js';
import { loadConfig } from '../utils/config.js';
import { writeStepOutput } from '../utils/file-io.js';

export default class Convert extends Command {
    static override description =
        'Convert Serverless Framework project(s) into CDK-ready artifacts by extracting and transforming the CloudFormation template.';

    static override examples = [
        '<%= config.bin %> convert --output ./output',
        '<%= config.bin %> convert --stage prod --config ./sls-2-cdk.config.json',
        '<%= config.bin %> convert -i ./svc1 -i ./svc2 -o ./out',
    ];

    static override flags = {
        config: Flags.file({
            char: 'c',
            description: 'Path to config file specifying resources to remove',
            exists: true,
        }),
        input: Flags.directory({
            char: 'i',
            description: 'Path(s) to Serverless Framework project(s)',
            multiple: true,
            default: ['.'],
        }),
        output: Flags.directory({
            char: 'o',
            description: 'Output directory for intermediate JSON files',
            default: '.sls-2-cdk',
        }),

        stage: Flags.string({
            char: 's',
            description: 'Stage name for serverless package',
            default: 'dev',
        }),
    };

    async run(): Promise<void> {
        const { flags } = await this.parse(Convert);

        const outputDir = path.resolve(flags.output);
        const stage = flags.stage;
        const config = loadConfig(flags.config);
        const inputPaths = flags.input.map((p: string) => path.resolve(p));
        const isMultiProject = inputPaths.length > 1;

        fs.mkdirSync(outputDir, { recursive: true });

        this.log(`Output directory: ${outputDir}`);
        this.log(`Stage: ${stage}`);
        this.log(`Projects: ${inputPaths.length}`);
        this.log('---');

        for (const servicePath of inputPaths) {
            const projectName = path.basename(servicePath);
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

        try {
            this.log('Step 1/5: Substituting SSM parameters...');
            const ssmResult = this.runStep('01-ssm-substitution', outputDir, () =>
                substituteSSM(serverlessYmlPath)
            );

            this.log('Step 2/5: Running serverless package...');
            const packageResult = this.runStep('02-package', outputDir, () =>
                runServerlessPackage(servicePath, stage)
            );

            this.log('Step 3/5: Removing Serverless-specific resources...');
            const templatePath = packageResult.data.templatePath;
            const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
            const removeResult = this.runStep('03-remove-resources', outputDir, () =>
                removeResources(template, config)
            );

            this.log('Step 4/5: Building resource map...');
            const resourceMapResult = this.runStep('04-resource-map', outputDir, () =>
                buildResourceMap(removeResult.data.template)
            );

            this.log('Step 5/5: Building Lambda environment variable map...');
            const envMapResult = this.runStep('05-env-map', outputDir, () =>
                buildEnvMap(removeResult.data.template)
            );

            // Summary
            this.log('---');
            this.log('Conversion complete!');
            this.log(`  SSM substitutions: ${ssmResult.data.count}`);
            this.log(`  Resources removed: ${removeResult.data.removed.length}`);
            this.log(`  Resources mapped:  ${resourceMapResult.data.totalCount}`);
            this.log(`  Lambda functions:  ${envMapResult.data.functionCount}`);
            this.log(`  Output files in:   ${outputDir}`);
        } finally {
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

    private findServerlessYml(dir: string): string | null {
        for (const name of ['serverless.yml', 'serverless.yaml']) {
            const fullPath = path.join(dir, name);
            if (fs.existsSync(fullPath)) return fullPath;
        }
        return null;
    }
}
