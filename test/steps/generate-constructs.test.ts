import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateConstructs } from '../../src/steps/generate-constructs.js';
import type { CloudFormationTemplate, EnvVarEntry } from '../../src/types/index.js';

const INDEX_TS_SKELETON = `
export class MigratedResources {
    constructor(scope: any, id: string) {
        super(scope, id);
    }
}
`.trimStart();

function makeServiceDir(base: string): string {
    const srcDir = path.join(base, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), INDEX_TS_SKELETON);
    return base;
}

function makeSharedEnvVar(name: string, value: string): EnvVarEntry {
    return { name, value, isIntrinsic: false, isShared: true };
}

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sls2cdk-test-'));
    makeServiceDir(tmpDir);
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
                        MemorySize: 192,
                    },
                },
            },
        };
        const result = generateConstructs(template, true, tmpDir, {});

        expect(result.generatedCount).toBe(1);
        expect(result.skippedCount).toBe(0);
        expect(result.generated[0]!.logicalId).toBe('MyFunc');
        expect(result.generated[0]!.cdkClass).toBe('lambdaNodejs.NodejsFunction');

        const content = fs.readFileSync(result.outputPath, 'utf-8');
        expect(content).toContain('import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs"');
        expect(content).toContain("new lambdaNodejs.NodejsFunction(this, 'MyFunc'");
        expect(content).toContain("functionName: 'my-func'");
        expect(content).toContain('memorySize: 192');
    });

    it('should generate constructs for multiple resource types', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { MemorySize: 128 },
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
        const result = generateConstructs(template, false, tmpDir, {});

        expect(result.generatedCount).toBe(3);
        expect(result.skippedCount).toBe(0);

        const content = fs.readFileSync(result.outputPath, 'utf-8');
        expect(content).toContain('import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs"');
        expect(content).toContain('import * as dynamodb from "aws-cdk-lib/aws-dynamodb"');
        expect(content).toContain('import * as s3 from "aws-cdk-lib/aws-s3"');
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
                    Properties: { MemorySize: 128 },
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});

        expect(result.generatedCount).toBe(1);
        expect(result.skippedCount).toBe(1);
        expect(result.skipped[0]!.logicalId).toBe('CustomRes');
        expect(result.skipped[0]!.cfnType).toBe('Custom::S3');
    });

    it('should skip resource types not in the CFN-to-CDK map', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyWaitHandle: {
                    Type: 'AWS::CloudFormation::WaitConditionHandle',
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});

        expect(result.generatedCount).toBe(0);
        expect(result.skippedCount).toBe(1);
        expect(result.skipped[0]!.reason).toContain('No CDK mapping');
    });

    it('should convert Ref intrinsic to Fn.ref', () => {
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
        const result = generateConstructs(template, false, tmpDir, {});
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("cdk.Fn.ref('MyTable')");
    });

    it('should convert Fn::GetAtt intrinsic to Fn.getAtt', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyQueue: {
                    Type: 'AWS::SQS::Queue',
                    Properties: {
                        RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['MyDLQ', 'Arn'] } },
                    },
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("cdk.Fn.getAtt('MyDLQ', 'Arn')");
    });

    it('should convert Fn::Sub intrinsic to Fn.sub', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: {
                        Environment: {
                            Variables: { SERVICE_URL: { 'Fn::Sub': 'https://${AWS::StackName}.example.com' } },
                        },
                    },
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("cdk.Fn.sub('https://${AWS::StackName}.example.com')");
    });

    it('should map AWS pseudo-parameters to Aws constants', () => {
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
        const result = generateConstructs(template, false, tmpDir, {});
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
                        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
                    },
                },
            },
        };
        const result = generateConstructs(template, true, tmpDir, {});
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
        const result = generateConstructs(template, false, tmpDir, {});
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("DB_HOST: 'localhost'");
        expect(content).toContain("STAGE: 'dev'");
    });

    it('should handle empty Resources', () => {
        const template: CloudFormationTemplate = { Resources: {} };
        const result = generateConstructs(template, false, tmpDir, {});

        expect(result.generatedCount).toBe(0);
        expect(result.skippedCount).toBe(0);

        const content = fs.readFileSync(result.outputPath, 'utf-8');
        expect(content).toContain('class MigratedResources');
        expect(content).toContain('super(scope, id)');
    });

    it('should handle resources with no Properties', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyBucket: { Type: 'AWS::S3::Bucket' },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});

        expect(result.generatedCount).toBe(1);

        const content = fs.readFileSync(result.outputPath, 'utf-8');
        expect(content).toContain("new s3.Bucket(this, 'MyBucket', {})");
    });

    it('should add DependsOn as a comment', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { MemorySize: 128 },
                    DependsOn: ['MyRole', 'MyLogGroup'],
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain('// DependsOn: MyRole, MyLogGroup');
    });

    it('should add Condition as a comment', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { MemorySize: 128 },
                    Condition: 'IsProd',
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain('// Condition: IsProd');
    });

    it('should deduplicate module imports for same-module resources', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                IngressQueue: { Type: 'AWS::SQS::Queue', Properties: {} },
                EgressQueue: { Type: 'AWS::SQS::Queue', Properties: {} },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        const sqsImports = content.match(/import \* as sqs from/g);
        expect(sqsImports).toHaveLength(1);
    });

    it('should add TODO comment for each generated construct', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { MemorySize: 128 },
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain('// TODO: Review and adjust properties for NodejsFunction');
    });

    it('should write output file to src/index.ts in the destination', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { MemorySize: 128 },
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});

        expect(result.outputPath).toBe(path.join(tmpDir, 'src', 'index.ts'));
        expect(fs.existsSync(result.outputPath)).toBe(true);
    });

    it('should extract common env vars into a sharedEnv constant', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                FuncA: {
                    Type: 'AWS::Lambda::Function',
                    Properties: {
                        Environment: {
                            Variables: { STAGE: 'prod', BRAND: 'acme', UNIQUE_A: 'only-in-a' },
                        },
                    },
                },
                FuncB: {
                    Type: 'AWS::Lambda::Function',
                    Properties: {
                        Environment: {
                            Variables: { STAGE: 'prod', BRAND: 'acme', UNIQUE_B: 'only-in-b' },
                        },
                    },
                },
            },
        };
        const sharedEnvVars: EnvVarEntry[] = [
            makeSharedEnvVar('STAGE', 'prod'),
            makeSharedEnvVar('BRAND', 'acme'),
        ];
        const result = generateConstructs(template, false, tmpDir, {}, sharedEnvVars);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("const sharedEnv = { STAGE: 'prod', BRAND: 'acme' }");
        expect(content).toContain('...sharedEnv');
        expect(content).toContain("UNIQUE_A: 'only-in-a'");
        expect(content).toContain("UNIQUE_B: 'only-in-b'");
        // Common vars should not be inlined per-lambda
        expect(content).not.toMatch(/STAGE: 'prod'.*UNIQUE/);
    });

    it('should not add sharedEnv when fewer than 2 lambdas share env vars', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: {
                        Environment: { Variables: { STAGE: 'prod' } },
                    },
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {}, []);
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).not.toContain('sharedEnv');
        expect(content).toContain("STAGE: 'prod'");
    });
});
