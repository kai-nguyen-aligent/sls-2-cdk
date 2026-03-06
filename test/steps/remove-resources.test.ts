import { describe, expect, it } from 'vitest';
import { removeResources } from '../../src/steps/remove-resources.js';
import type { CloudFormationTemplate, Sls2CdkConfig } from '../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../src/types/index.js';

function makeTemplate(
    resources: Record<
        string,
        { Type: string; DependsOn?: string | string[]; Properties?: Record<string, unknown> }
    >,
    outputs?: Record<string, unknown>
): CloudFormationTemplate {
    return {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: resources,
        Outputs: outputs,
    };
}

describe('removeResources', () => {
    it('should remove by exact logical ID', () => {
        const template = makeTemplate({
            ServerlessDeploymentBucket: { Type: 'AWS::S3::Bucket' },
            MyFunction: { Type: 'AWS::Lambda::Function' },
        });
        const result = removeResources(template, DEFAULT_CONFIG);

        expect(result.removed).toHaveLength(1);
        expect(result.removed[0].logicalId).toBe('ServerlessDeploymentBucket');
        expect(result.removed[0].reason).toBe('id_match');
        expect(result.remainingCount).toBe(1);
        expect(result.template.Resources['MyFunction']).toBeDefined();
        expect(result.template.Resources['ServerlessDeploymentBucket']).toBeUndefined();
    });

    it('should remove by type pattern with wildcard', () => {
        const template = makeTemplate({
            CustomDashS3: { Type: 'Custom::S3' },
            CustomDashOther: { Type: 'Custom::Other' },
            MyFunction: { Type: 'AWS::Lambda::Function' },
        });
        const result = removeResources(template, DEFAULT_CONFIG);

        expect(result.removed).toHaveLength(2);
        expect(result.removed.every(r => r.reason === 'type_pattern_match')).toBe(true);
        expect(result.remainingCount).toBe(1);
    });

    it('should keep resources not matching any rule', () => {
        const template = makeTemplate({
            MyFunction: { Type: 'AWS::Lambda::Function' },
            MyTable: { Type: 'AWS::DynamoDB::Table' },
        });
        const result = removeResources(template, DEFAULT_CONFIG);

        expect(result.removed).toHaveLength(0);
        expect(result.remainingCount).toBe(2);
    });

    it('should clean up DependsOn string reference to removed resource', () => {
        const template = makeTemplate({
            ServerlessDeploymentBucket: { Type: 'AWS::S3::Bucket' },
            BucketPolicy: {
                Type: 'AWS::S3::BucketPolicy',
                DependsOn: 'ServerlessDeploymentBucket',
            },
        });
        const result = removeResources(template, DEFAULT_CONFIG);

        expect(result.template.Resources['BucketPolicy'].DependsOn).toBeUndefined();
    });

    it('should clean up DependsOn array reference to removed resource', () => {
        const template = makeTemplate({
            ServerlessDeploymentBucket: { Type: 'AWS::S3::Bucket' },
            MyFunction: {
                Type: 'AWS::Lambda::Function',
                DependsOn: ['ServerlessDeploymentBucket', 'MyTable'],
            },
            MyTable: { Type: 'AWS::DynamoDB::Table' },
        });
        const result = removeResources(template, DEFAULT_CONFIG);

        expect(result.template.Resources['MyFunction'].DependsOn).toEqual(['MyTable']);
    });

    it('should remove DependsOn entirely if array becomes empty', () => {
        const template = makeTemplate({
            ServerlessDeploymentBucket: { Type: 'AWS::S3::Bucket' },
            MyResource: {
                Type: 'AWS::CloudFormation::WaitConditionHandle',
                DependsOn: ['ServerlessDeploymentBucket'],
            },
        });
        const result = removeResources(template, DEFAULT_CONFIG);

        expect(result.template.Resources['MyResource'].DependsOn).toBeUndefined();
    });

    it('should clean up Outputs referencing removed resources', () => {
        const template = makeTemplate(
            {
                ServerlessDeploymentBucket: { Type: 'AWS::S3::Bucket' },
                MyFunction: { Type: 'AWS::Lambda::Function' },
            },
            {
                BucketName: { Value: { Ref: 'ServerlessDeploymentBucket' } },
                FunctionArn: { Value: { 'Fn::GetAtt': ['MyFunction', 'Arn'] } },
            }
        );
        const result = removeResources(template, DEFAULT_CONFIG);

        expect(result.template.Outputs).toBeDefined();
        expect(result.template.Outputs!['FunctionArn']).toBeDefined();
        expect(result.template.Outputs!['BucketName']).toBeUndefined();
    });

    it('should handle empty Resources', () => {
        const template = makeTemplate({});
        const result = removeResources(template, DEFAULT_CONFIG);

        expect(result.removed).toHaveLength(0);
        expect(result.remainingCount).toBe(0);
    });

    it('should merge user config with defaults', () => {
        const config: Sls2CdkConfig = {
            removeResourceIds: [...DEFAULT_CONFIG.removeResourceIds, 'MyExtraResource'],
            removeResourceTypePatterns: [...DEFAULT_CONFIG.removeResourceTypePatterns],
        };
        const template = makeTemplate({
            ServerlessDeploymentBucket: { Type: 'AWS::S3::Bucket' },
            MyExtraResource: { Type: 'AWS::SNS::Topic' },
            MyFunction: { Type: 'AWS::Lambda::Function' },
        });
        const result = removeResources(template, config);

        expect(result.removed).toHaveLength(2);
        expect(result.remainingCount).toBe(1);
    });
});
