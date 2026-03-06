import { describe, expect, it } from 'vitest';
import { buildEnvMap } from '../../src/steps/build-env-map.js';
import type { CloudFormationTemplate } from '../../src/types/index.js';

function makeLambdaTemplate(
    functions: Record<
        string,
        { env?: Record<string, unknown>; handler?: string; runtime?: string; functionName?: string }
    >
): CloudFormationTemplate {
    const resources: Record<string, { Type: string; Properties: Record<string, unknown> }> = {};
    for (const [id, fn] of Object.entries(functions)) {
        resources[id] = {
            Type: 'AWS::Lambda::Function',
            Properties: {
                ...(fn.handler && { Handler: fn.handler }),
                ...(fn.runtime && { Runtime: fn.runtime }),
                ...(fn.functionName && { FunctionName: fn.functionName }),
                ...(fn.env && { Environment: { Variables: fn.env } }),
            },
        };
    }
    return { Resources: resources };
}

describe('buildEnvMap', () => {
    it('should extract basic string env vars', () => {
        const template = makeLambdaTemplate({
            MyFunc: { env: { DB_HOST: 'localhost', PORT: '3000' }, handler: 'a.handler' },
        });
        const result = buildEnvMap(template);

        expect(result.functionCount).toBe(1);
        expect(result.functions[0].variables).toHaveLength(2);
        expect(result.functions[0].variables[0].isIntrinsic).toBe(false);
    });

    it('should detect Ref intrinsic', () => {
        const template = makeLambdaTemplate({
            MyFunc: { env: { TABLE: { Ref: 'MyTable' } } },
        });
        const result = buildEnvMap(template);

        expect(result.functions[0].variables[0].isIntrinsic).toBe(true);
        expect(result.functions[0].variables[0].intrinsicType).toBe('Ref');
    });

    it('should detect Fn::GetAtt intrinsic', () => {
        const template = makeLambdaTemplate({
            MyFunc: { env: { QUEUE_ARN: { 'Fn::GetAtt': ['MyQueue', 'Arn'] } } },
        });
        const result = buildEnvMap(template);

        expect(result.functions[0].variables[0].intrinsicType).toBe('Fn::GetAtt');
    });

    it('should detect Fn::Sub intrinsic', () => {
        const template = makeLambdaTemplate({
            MyFunc: { env: { URL: { 'Fn::Sub': 'https://${MyApi}.example.com' } } },
        });
        const result = buildEnvMap(template);

        expect(result.functions[0].variables[0].intrinsicType).toBe('Fn::Sub');
    });

    it('should detect Fn::ImportValue intrinsic', () => {
        const template = makeLambdaTemplate({
            MyFunc: { env: { SHARED_URL: { 'Fn::ImportValue': 'OtherStack-ApiUrl' } } },
        });
        const result = buildEnvMap(template);

        expect(result.functions[0].variables[0].intrinsicType).toBe('Fn::ImportValue');
    });

    it('should classify mixed intrinsics and strings correctly', () => {
        const template = makeLambdaTemplate({
            MyFunc: {
                env: {
                    PLAIN: 'value',
                    REF_VAL: { Ref: 'SomeResource' },
                    ANOTHER_PLAIN: '123',
                },
            },
        });
        const result = buildEnvMap(template);
        const vars = result.functions[0].variables;

        expect(vars.find(v => v.name === 'PLAIN')!.isIntrinsic).toBe(false);
        expect(vars.find(v => v.name === 'REF_VAL')!.isIntrinsic).toBe(true);
        expect(vars.find(v => v.name === 'ANOTHER_PLAIN')!.isIntrinsic).toBe(false);
    });

    it('should skip Lambda functions without Environment block', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: { Type: 'AWS::Lambda::Function', Properties: { Handler: 'a.handler' } },
            },
        };
        const result = buildEnvMap(template);

        expect(result.functionCount).toBe(0);
    });

    it('should ignore non-Lambda resources', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'test' } },
                MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
            },
        };
        const result = buildEnvMap(template);

        expect(result.functionCount).toBe(0);
    });

    it('should find shared variables across functions', () => {
        const template = makeLambdaTemplate({
            Func1: { env: { STAGE: 'dev', DB: 'host1' } },
            Func2: { env: { STAGE: 'dev', DB: 'host2' } },
        });
        const result = buildEnvMap(template);

        expect(result.sharedVariables).toHaveLength(1);
        expect(result.sharedVariables[0].name).toBe('STAGE');
        expect(result.sharedVariables[0].value).toBe('dev');
    });

    it('should not count non-shared variables as shared', () => {
        const template = makeLambdaTemplate({
            Func1: { env: { DB: 'host1' } },
            Func2: { env: { DB: 'host2' } },
        });
        const result = buildEnvMap(template);

        expect(result.sharedVariables).toHaveLength(0);
    });

    it('should return empty sharedVariables for single function', () => {
        const template = makeLambdaTemplate({
            Func1: { env: { STAGE: 'dev' } },
        });
        const result = buildEnvMap(template);

        expect(result.sharedVariables).toHaveLength(0);
    });

    it('should collect all unique var names', () => {
        const template = makeLambdaTemplate({
            Func1: { env: { A: '1', B: '2' } },
            Func2: { env: { B: '2', C: '3' } },
        });
        const result = buildEnvMap(template);

        expect(result.allUniqueVarNames).toEqual(['A', 'B', 'C']);
    });

    it('should extract function metadata', () => {
        const template = makeLambdaTemplate({
            MyFunc: {
                env: { X: 'val' },
                handler: 'handler.main',
                runtime: 'nodejs20.x',
                functionName: 'my-svc-dev-func',
            },
        });
        const result = buildEnvMap(template);

        expect(result.functions[0].handler).toBe('handler.main');
        expect(result.functions[0].runtime).toBe('nodejs20.x');
        expect(result.functions[0].functionName).toBe('my-svc-dev-func');
        expect(result.functions[0].logicalId).toBe('MyFunc');
    });
});
