import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateConstructs } from '../../src/steps/generate-constructs.js';
import type { CloudFormationTemplate } from '../../src/types/index.js';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sls2cdk-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateConstructs', () => {
    it('should generate a NodejsFunction for AWS::Lambda::Function', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: {
                        FunctionName: 'my-func',
                        Handler: 'index.handler',
                        Runtime: 'nodejs20.x',
                    },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);

        expect(result.generatedCount).toBe(1);
        expect(result.skippedCount).toBe(0);
        expect(result.generated[0].logicalId).toBe('MyFunc');
        expect(result.generated[0].cdkClass).toBe('lambdaNodejs.NodejsFunction');

        const content = fs.readFileSync(result.outputPath, 'utf-8');
        expect(content).toContain("import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs'");
        expect(content).toContain("new lambdaNodejs.NodejsFunction(this, 'MyFunc'");
        expect(content).toContain("functionName: 'my-func'");
        expect(content).toContain("handler: 'index.handler'");
    });

    it('should generate constructs for multiple resource types', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { Handler: 'a.handler' },
                },
                MyTable: {
                    Type: 'AWS::DynamoDB::Table',
                    Properties: { TableName: 'items' },
                },
                MyBucket: {
                    Type: 'AWS::S3::Bucket',
                    Properties: { BucketName: 'uploads' },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);

        expect(result.generatedCount).toBe(3);
        expect(result.skippedCount).toBe(0);

        const content = fs.readFileSync(result.outputPath, 'utf-8');
        expect(content).toContain("import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs'");
        expect(content).toContain("import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'");
        expect(content).toContain("import * as s3 from 'aws-cdk-lib/aws-s3'");
        expect(content).toContain('new lambdaNodejs.NodejsFunction');
        expect(content).toContain('new dynamodb.Table');
        expect(content).toContain('new s3.Bucket');
    });

    it('should skip Custom:: resource types', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                CustomRes: { Type: 'Custom::S3' },
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { Handler: 'a.b' },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);

        expect(result.generatedCount).toBe(1);
        expect(result.skippedCount).toBe(1);
        expect(result.skipped[0].logicalId).toBe('CustomRes');
        expect(result.skipped[0].cfnType).toBe('Custom::S3');
    });

    it('should skip resource types not in the CFN-to-CDK map', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyWaitHandle: {
                    Type: 'AWS::CloudFormation::WaitConditionHandle',
                },
            },
        };
        const result = generateConstructs(template, tmpDir);

        expect(result.generatedCount).toBe(0);
        expect(result.skippedCount).toBe(1);
        expect(result.skipped[0].reason).toContain('No CDK mapping');
    });

    it('should convert Ref intrinsic to cdk.Fn.ref', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: {
                        Environment: {
                            Variables: { TABLE_NAME: { Ref: 'MyTable' } },
                        },
                    },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("cdk.Fn.ref('MyTable')");
    });

    it('should convert Fn::GetAtt intrinsic to cdk.Fn.getAtt', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MySfn: {
                    Type: 'AWS::StepFunctions::StateMachine',
                    Properties: {
                        RoleArn: { 'Fn::GetAtt': ['MyRole', 'Arn'] },
                    },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("cdk.Fn.getAtt('MyRole', 'Arn')");
    });

    it('should convert Fn::Sub intrinsic to cdk.Fn.sub', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MySfn: {
                    Type: 'AWS::StepFunctions::StateMachine',
                    Properties: {
                        DefinitionString: { 'Fn::Sub': '${AWS::StackName}-workflow' },
                    },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("cdk.Fn.sub('${AWS::StackName}-workflow')");
    });

    it('should map AWS pseudo-parameters to cdk.Aws constants', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: {
                        Environment: {
                            Variables: {
                                REGION: { Ref: 'AWS::Region' },
                                ACCOUNT: { Ref: 'AWS::AccountId' },
                            },
                        },
                    },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain('cdk.Aws.REGION');
        expect(content).toContain('cdk.Aws.ACCOUNT_ID');
    });

    it('should convert PascalCase property keys to camelCase', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyTable: {
                    Type: 'AWS::DynamoDB::Table',
                    Properties: {
                        TableName: 'test',
                        BillingMode: 'PAY_PER_REQUEST',
                        AttributeDefinitions: [
                            { AttributeName: 'id', AttributeType: 'S' },
                        ],
                    },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("tableName: 'test'");
        expect(content).toContain("billingMode: 'PAY_PER_REQUEST'");
        expect(content).toContain("attributeName: 'id'");
        expect(content).toContain("attributeType: 'S'");
    });

    it('should preserve ALL_CAPS keys (e.g., env var names)', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: {
                        Environment: {
                            Variables: {
                                DB_HOST: 'localhost',
                                STAGE: 'dev',
                            },
                        },
                    },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("DB_HOST: 'localhost'");
        expect(content).toContain("STAGE: 'dev'");
    });

    it('should handle empty Resources', () => {
        const template: CloudFormationTemplate = { Resources: {} };
        const result = generateConstructs(template, tmpDir);

        expect(result.generatedCount).toBe(0);
        expect(result.skippedCount).toBe(0);

        const content = fs.readFileSync(result.outputPath, 'utf-8');
        expect(content).toContain('class MigratedResources');
        expect(content).toContain('super(scope, id)');
    });

    it('should handle resources with no Properties', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyRole: { Type: 'AWS::IAM::Role' },
            },
        };
        const result = generateConstructs(template, tmpDir);

        expect(result.generatedCount).toBe(1);

        const content = fs.readFileSync(result.outputPath, 'utf-8');
        expect(content).toContain("new iam.Role(this, 'MyRole', {})");
    });

    it('should add DependsOn as a comment', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { Handler: 'a.b' },
                    DependsOn: ['MyRole', 'MyLogGroup'],
                },
            },
        };
        const result = generateConstructs(template, tmpDir);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain('// DependsOn: MyRole, MyLogGroup');
    });

    it('should add Condition as a comment', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { Handler: 'a.b' },
                    Condition: 'IsProd',
                },
            },
        };
        const result = generateConstructs(template, tmpDir);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain('// Condition: IsProd');
    });

    it('should deduplicate module imports for same-module resources', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                Role1: { Type: 'AWS::IAM::Role', Properties: {} },
                Policy1: { Type: 'AWS::IAM::Policy', Properties: {} },
            },
        };
        const result = generateConstructs(template, tmpDir);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        const iamImports = content.match(/import \* as iam from/g);
        expect(iamImports).toHaveLength(1);
    });

    it('should add TODO comment for each generated construct', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { Handler: 'a.b' },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain('// TODO: Review and adjust properties for NodejsFunction');
    });

    it('should write output file to destination path', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { Handler: 'a.b' },
                },
            },
        };
        const result = generateConstructs(template, tmpDir);

        expect(result.outputPath).toBe(path.join(tmpDir, 'migrated-resources.ts'));
        expect(fs.existsSync(result.outputPath)).toBe(true);
    });
});
