import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { substituteVariables } from '../../src/steps/substitute-variables.js';

describe('substituteVariables', () => {
    let tmpDir: string;
    let ymlPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sls2cdk-test-'));
        ymlPath = path.join(tmpDir, 'serverless.yml');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('referenced file substitution', () => {
        it('should create -sub copies of referenced files with all variables substituted', () => {
            fs.writeFileSync(ymlPath, 'custom:\n  env: ${file(./env.json)}');
            fs.writeFileSync(
                path.join(tmpDir, 'env.json'),
                '{"db": "${ssm:/app/db}", "key": "${env:API_KEY}"}'
            );

            const result = substituteVariables(ymlPath);

            const subPath = path.join(tmpDir, 'env-vars-subsitution.json');
            expect(fs.existsSync(subPath)).toBe(true);
            const subContent = fs.readFileSync(subPath, 'utf-8');
            expect(subContent).toMatch(/__SLS2CDK_VAR_\d+__/);
            expect(subContent).not.toContain('${ssm:');
            expect(subContent).not.toContain('${env:');
            expect(result.substitutions).toHaveLength(2);
        });

        it('should not modify the original referenced file', () => {
            const originalContent = '{"db": "${ssm:/app/db}"}';
            fs.writeFileSync(ymlPath, 'custom:\n  env: ${file(./env.json)}');
            fs.writeFileSync(path.join(tmpDir, 'env.json'), originalContent);

            substituteVariables(ymlPath);

            expect(fs.readFileSync(path.join(tmpDir, 'env.json'), 'utf-8')).toBe(originalContent);
        });

        it('should skip referenced files with no variables', () => {
            fs.writeFileSync(ymlPath, 'custom:\n  env: ${file(./env.json)}');
            fs.writeFileSync(path.join(tmpDir, 'env.json'), '{"db": "localhost"}');

            const result = substituteVariables(ymlPath);

            expect(fs.existsSync(path.join(tmpDir, 'env-vars-subsitution.json'))).toBe(false);
            expect(result.substitutions).toHaveLength(0);
        });

        it('should skip referenced files that do not exist', () => {
            fs.writeFileSync(ymlPath, 'custom:\n  env: ${file(./missing.json)}');

            const result = substituteVariables(ymlPath);

            expect(result.substitutions).toHaveLength(0);
        });

        it('should substitute all variable types in referenced files', () => {
            fs.writeFileSync(ymlPath, 'custom:\n  config: ${file(./config.yml)}');
            fs.writeFileSync(
                path.join(tmpDir, 'config.yml'),
                'db: ${ssm:/db}\nstage: ${self:provider.stage}\nbucket: ${s3:my-bucket/key}'
            );

            substituteVariables(ymlPath);

            const subContent = fs.readFileSync(
                path.join(tmpDir, 'config-vars-subsitution.yml'),
                'utf-8'
            );
            // ALL variables in referenced files are substituted (including self:)
            expect(subContent).not.toContain('${ssm:');
            expect(subContent).not.toContain('${self:');
            expect(subContent).not.toContain('${s3:');
            expect(subContent).toMatch(
                /^db: __SLS2CDK_VAR_\d+__\nstage: __SLS2CDK_VAR_\d+__\nbucket: __SLS2CDK_VAR_\d+__$/
            );
        });
    });

    describe('serverless.yml → serverless-vars-subsitution.yml', () => {
        it('should not modify the original serverless.yml', () => {
            const original = 'DB_HOST: ${ssm:/myapp/db-host}';
            fs.writeFileSync(ymlPath, original);

            substituteVariables(ymlPath);

            expect(fs.readFileSync(ymlPath, 'utf-8')).toBe(original);
        });

        it('should create serverless-vars-subsitution.yml with external variables substituted', () => {
            fs.writeFileSync(ymlPath, 'DB_HOST: ${ssm:/myapp/db-host}');

            const result = substituteVariables(ymlPath);

            const subContent = fs.readFileSync(result.serverlessSubPath, 'utf-8');
            expect(subContent).toBe('DB_HOST: __SLS2CDK_VAR_0__');
        });

        it('should substitute all external variable types', () => {
            const content = [
                'ssm_val: ${ssm:/app/key}',
                's3_val: ${s3:my-bucket/config.json}',
                'cf_val: ${cf:my-stack.OutputKey}',
                'env_val: ${env:MY_VAR}',
                'aws_val: ${aws:accountId}',
            ].join('\n');
            fs.writeFileSync(ymlPath, content);

            const result = substituteVariables(ymlPath);

            expect(result.count).toBe(5);
            const subContent = fs.readFileSync(result.serverlessSubPath, 'utf-8');
            expect(subContent).not.toContain('${ssm:');
            expect(subContent).not.toContain('${s3:');
            expect(subContent).not.toContain('${cf:');
            expect(subContent).not.toContain('${env:');
            expect(subContent).not.toContain('${aws:');
        });

        it('should preserve local variables (self, sls, opt)', () => {
            const content = [
                'stage: ${sls:stage}',
                'name: ${self:service}',
                'flag: ${opt:verbose}',
                'db: ${ssm:/app/db}',
            ].join('\n');
            fs.writeFileSync(ymlPath, content);

            const result = substituteVariables(ymlPath);

            const subContent = fs.readFileSync(result.serverlessSubPath, 'utf-8');
            expect(subContent).toContain('${sls:stage}');
            expect(subContent).toContain('${self:service}');
            expect(subContent).toContain('${opt:verbose}');
            expect(subContent).not.toContain('${ssm:');
            expect(result.count).toBe(1);
        });

        it('should not substitute CloudFormation !Sub references', () => {
            fs.writeFileSync(ymlPath, 'Resource: !Sub arn:aws:s3:::${S3BucketName}/*');

            const result = substituteVariables(ymlPath);

            const subContent = fs.readFileSync(result.serverlessSubPath, 'utf-8');
            expect(subContent).toContain('${S3BucketName}');
            expect(result.count).toBe(0);
        });

        it('should rewrite ${file(...)} paths to -sub versions when file was processed', () => {
            fs.writeFileSync(ymlPath, 'custom:\n  env: ${file(./env.json)}');
            fs.writeFileSync(path.join(tmpDir, 'env.json'), '{"key": "${ssm:/app/key}"}');

            const result = substituteVariables(ymlPath);

            const subContent = fs.readFileSync(result.serverlessSubPath, 'utf-8');
            expect(subContent).toContain('${file(env-vars-subsitution.json)}');
            expect(subContent).not.toContain('${file(./env.json)}');
        });

        it('should keep ${file(...)} paths unchanged when file had no variables', () => {
            fs.writeFileSync(ymlPath, 'custom:\n  env: ${file(./env.json)}');
            fs.writeFileSync(path.join(tmpDir, 'env.json'), '{"key": "static"}');

            const result = substituteVariables(ymlPath);

            const subContent = fs.readFileSync(result.serverlessSubPath, 'utf-8');
            expect(subContent).toContain('${file(./env.json)}');
        });

        it('should handle nested variables in SSM paths', () => {
            fs.writeFileSync(ymlPath, 'DB: ${ssm:/app/${sls:stage}/db}');

            const result = substituteVariables(ymlPath);

            expect(result.count).toBe(1);
            expect(result.substitutions[0].original).toBe('${ssm:/app/${sls:stage}/db}');
            const subContent = fs.readFileSync(result.serverlessSubPath, 'utf-8');
            expect(subContent).toBe('DB: __SLS2CDK_VAR_0__');
        });

        it('should handle SSM ref inside YAML quoted string', () => {
            fs.writeFileSync(ymlPath, 'DB: "${ssm:/myapp/db}"');

            const result = substituteVariables(ymlPath);

            const subContent = fs.readFileSync(result.serverlessSubPath, 'utf-8');
            expect(subContent).toBe('DB: "__SLS2CDK_VAR_0__"');
        });
    });

    describe('unified substitution map', () => {
        it('should track variable types correctly', () => {
            const content = [
                'ssm_val: ${ssm:/key}',
                'env_val: ${env:VAR}',
                'aws_val: ${aws:accountId}',
            ].join('\n');
            fs.writeFileSync(ymlPath, content);

            const result = substituteVariables(ymlPath);

            const types = result.substitutions.map(s => s.variableType).sort();
            expect(types).toEqual(['aws', 'env', 'ssm']);
        });

        it('should include file path for each substitution', () => {
            fs.writeFileSync(ymlPath, 'custom:\n  env: ${file(./env.json)}\n  db: ${ssm:/db}');
            fs.writeFileSync(path.join(tmpDir, 'env.json'), '{"key": "${env:KEY}"}');

            const result = substituteVariables(ymlPath);

            const envSub = result.substitutions.find(s => s.original === '${env:KEY}');
            const ssmSub = result.substitutions.find(s => s.original === '${ssm:/db}');
            expect(envSub?.filePath).toBe(path.join(tmpDir, 'env.json'));
            expect(ssmSub?.filePath).toBe(ymlPath);
        });

        it('should use globally unique placeholder indices', () => {
            fs.writeFileSync(ymlPath, 'custom:\n  env: ${file(./env.json)}\n  db: ${ssm:/db}');
            fs.writeFileSync(path.join(tmpDir, 'env.json'), '{"a": "${env:A}", "b": "${env:B}"}');

            const result = substituteVariables(ymlPath);

            const placeholders = result.substitutions.map(s => s.placeholder);
            expect(placeholders).toContain('__SLS2CDK_VAR_0__');
            expect(placeholders).toContain('__SLS2CDK_VAR_1__');
            expect(placeholders).toContain('__SLS2CDK_VAR_2__');
            expect(new Set(placeholders).size).toBe(placeholders.length);
        });
    });

    describe('subFiles tracking and cleanup', () => {
        it('should list all generated -sub files', () => {
            fs.writeFileSync(ymlPath, 'custom:\n  env: ${file(./env.json)}\n  db: ${ssm:/db}');
            fs.writeFileSync(path.join(tmpDir, 'env.json'), '{"key": "${env:KEY}"}');

            const result = substituteVariables(ymlPath);

            expect(result.subFiles).toContain(path.join(tmpDir, 'env-vars-subsitution.json'));
            expect(result.subFiles).toContain(path.join(tmpDir, 'serverless-vars-subsitution.yml'));
        });

        it('should delete all -sub files on cleanup', () => {
            fs.writeFileSync(ymlPath, 'custom:\n  env: ${file(./env.json)}\n  db: ${ssm:/db}');
            fs.writeFileSync(path.join(tmpDir, 'env.json'), '{"key": "${env:KEY}"}');

            const result = substituteVariables(ymlPath);

            for (const f of result.subFiles) {
                expect(fs.existsSync(f)).toBe(true);
            }

            cleanupSubFiles(result.subFiles);

            for (const f of result.subFiles) {
                expect(fs.existsSync(f)).toBe(false);
            }
        });

        it('should not fail when cleaning up already-deleted files', () => {
            cleanupSubFiles(['/tmp/nonexistent-file.yml']);
        });
    });

    describe('return value', () => {
        it('should return count 0 when no substitutions are needed', () => {
            fs.writeFileSync(ymlPath, 'service: my-service\nprovider:\n  name: aws');

            const result = substituteVariables(ymlPath);

            expect(result.count).toBe(0);
            expect(result.substitutions).toHaveLength(0);
        });

        it('should always create serverless-vars-subsitution.yml even with no substitutions', () => {
            fs.writeFileSync(ymlPath, 'service: my-service');

            const result = substituteVariables(ymlPath);

            expect(fs.existsSync(result.serverlessSubPath)).toBe(true);
            expect(result.serverlessSubPath).toBe(
                path.join(tmpDir, 'serverless-vars-subsitution.yml')
            );
        });
    });
});
