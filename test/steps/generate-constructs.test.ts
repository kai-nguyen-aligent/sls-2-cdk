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

/** Reads the generated infra/lambda-functions.ts file. */
function readLambdaFunctionsFile(): string {
    return fs.readFileSync(path.join(tmpDir, 'src', 'infra', 'lambda-functions.ts'), 'utf-8');
}

/** Reads the generated infra/api-gateway.ts file. */
function readApiGatewayFile(): string {
    return fs.readFileSync(path.join(tmpDir, 'src', 'infra', 'api-gateway.ts'), 'utf-8');
}

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

        // Lambda construct lives in infra/lambda-functions.ts
        const lambdaContent = readLambdaFunctionsFile();
        expect(lambdaContent).toContain(
            'import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"'
        );
        expect(lambdaContent).toContain("new NodejsFunction(scope, 'MyFunc'");
        expect(lambdaContent).toContain("functionName: 'my-func'");
        expect(lambdaContent).toContain('memorySize: 192');

        // index.ts delegates to lambdaFunctions()
        const content = fs.readFileSync(result.outputPath, 'utf-8');
        expect(content).toContain('import { lambdaFunctions }');
        expect(content).toContain('lambdaFunctions(this, props)');
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

        // Lambda in its own file
        const lambdaContent = readLambdaFunctionsFile();
        expect(lambdaContent).toContain(
            'import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"'
        );
        expect(lambdaContent).toContain('new NodejsFunction');

        // Non-lambda constructs remain in index.ts
        const content = fs.readFileSync(result.outputPath, 'utf-8');
        expect(content).toContain('import * as dynamodb from "aws-cdk-lib/aws-dynamodb"');
        expect(content).toContain('import * as s3 from "aws-cdk-lib/aws-s3"');
        expect(content).toContain('new dynamodb.Table');
        expect(content).toContain('new s3.Bucket');
        expect(content).toContain('lambdaFunctions(this, props)');
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
        generateConstructs(template, false, tmpDir, {});
        const lambdaContent = readLambdaFunctionsFile();

        expect(lambdaContent).toContain("cdk.Fn.ref('MyTable')");
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
                            Variables: {
                                SERVICE_URL: { 'Fn::Sub': 'https://${AWS::StackName}.example.com' },
                            },
                        },
                    },
                },
            },
        };
        generateConstructs(template, false, tmpDir, {});
        const lambdaContent = readLambdaFunctionsFile();

        expect(lambdaContent).toContain("cdk.Fn.sub('https://${AWS::StackName}.example.com')");
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
        generateConstructs(template, false, tmpDir, {});
        const lambdaContent = readLambdaFunctionsFile();

        expect(lambdaContent).toContain('cdk.Aws.REGION');
        expect(lambdaContent).toContain('cdk.Aws.ACCOUNT_ID');
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
                        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
                    },
                },
            },
        };
        const result = generateConstructs(template, true, tmpDir, {});
        const content = fs.readFileSync(result.outputPath, 'utf-8');

        expect(content).toContain("tableName: 'test'");
        expect(content).toContain("billingMode: 'PAY_PER_REQUEST'");
        expect(content).toContain("name: 'id'");
        expect(content).toContain('dynamodb.AttributeType.STRING');
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
        generateConstructs(template, false, tmpDir, {});
        const lambdaContent = readLambdaFunctionsFile();

        expect(lambdaContent).toContain("DB_HOST: 'localhost'");
        expect(lambdaContent).toContain("STAGE: 'dev'");
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
        generateConstructs(template, false, tmpDir, {});
        const lambdaContent = readLambdaFunctionsFile();

        expect(lambdaContent).toContain('// DependsOn: MyRole, MyLogGroup');
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
        generateConstructs(template, false, tmpDir, {});
        const lambdaContent = readLambdaFunctionsFile();

        expect(lambdaContent).toContain('// Condition: IsProd');
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
        generateConstructs(template, false, tmpDir, {});
        const lambdaContent = readLambdaFunctionsFile();

        expect(lambdaContent).toContain('// TODO: Review and adjust properties for NodejsFunction');
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

    it('should extract common env vars into a sharedEnv constant in lambda-functions.ts', () => {
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
        generateConstructs(template, false, tmpDir, {}, sharedEnvVars);
        const lambdaContent = readLambdaFunctionsFile();

        expect(lambdaContent).toContain("const sharedEnv = { STAGE: 'prod', BRAND: 'acme' }");
        expect(lambdaContent).toContain('...sharedEnv');
        expect(lambdaContent).toContain("UNIQUE_A: 'only-in-a'");
        expect(lambdaContent).toContain("UNIQUE_B: 'only-in-b'");
        // Common vars should not be inlined per-lambda
        expect(lambdaContent).not.toMatch(/STAGE: 'prod'.*UNIQUE/);
    });

    it('should not add sharedEnv when no shared env vars are provided', () => {
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
        generateConstructs(template, false, tmpDir, {}, []);
        const lambdaContent = readLambdaFunctionsFile();

        expect(lambdaContent).not.toContain('sharedEnv');
        expect(lambdaContent).toContain("STAGE: 'prod'");
    });

    it('should link UsagePlan to RestApi via addApiStage and to ApiKey via addApiKey', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyRestApi: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
                MyApiKey: { Type: 'AWS::ApiGateway::ApiKey', Properties: {} },
                MyUsagePlan: { Type: 'AWS::ApiGateway::UsagePlan', Properties: {} },
            },
        };
        generateConstructs(template, false, tmpDir, {});
        const apiGwContent = readApiGatewayFile();

        expect(apiGwContent).toContain(
            'myUsagePlan.addApiStage({ api: myRestApi as IRestApi, stage: myRestApi.deploymentStage })'
        );
        expect(apiGwContent).toContain('myUsagePlan.addApiKey(myApiKey)');
    });

    it('should not add addApiStage or addApiKey when no UsagePlan is present', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyRestApi: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
                MyApiKey: { Type: 'AWS::ApiGateway::ApiKey', Properties: {} },
            },
        };
        generateConstructs(template, false, tmpDir, {});
        const apiGwContent = readApiGatewayFile();

        expect(apiGwContent).not.toContain('addApiStage');
        expect(apiGwContent).not.toContain('addApiKey');
    });

    it('should generate API Gateway resources in a separate infra/api-gateway.ts file', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyRestApi: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
                MyApiKey: { Type: 'AWS::ApiGateway::ApiKey', Properties: {} },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});
        const indexContent = fs.readFileSync(result.outputPath, 'utf-8');
        const apiGwContent = readApiGatewayFile();

        // API GW constructs go to the separate file as a class
        expect(apiGwContent).toContain('export class ApiGatewayResources');
        expect(apiGwContent).toContain("new RestApi(scope, 'MyRestApi'");
        expect(apiGwContent).toContain("new ApiKey(scope, 'MyApiKey'");

        // Named imports from aws-cdk-lib/aws-apigateway (not namespace)
        expect(apiGwContent).not.toContain('import * as apigw');
        expect(apiGwContent).toContain('from "aws-cdk-lib/aws-apigateway"');

        // index.ts gets the import and instantiation, not the construct definitions
        expect(indexContent).toContain('import { ApiGatewayResources }');
        expect(indexContent).toContain('new ApiGatewayResources(this)');
        expect(indexContent).not.toContain("new RestApi(this, 'MyRestApi'");
    });

    it('should pass lambdas to ApiGatewayResources when Lambda integrations are present', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: {
                    Type: 'AWS::Lambda::Function',
                    Properties: { MemorySize: 128 },
                },
                MyRestApi: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
                MyResource: {
                    Type: 'AWS::ApiGateway::Resource',
                    Properties: {
                        RestApiId: { Ref: 'MyRestApi' },
                        ParentId: { 'Fn::GetAtt': ['MyRestApi', 'RootResourceId'] },
                        PathPart: 'test',
                    },
                },
                MyMethod: {
                    Type: 'AWS::ApiGateway::Method',
                    Properties: {
                        RestApiId: { Ref: 'MyRestApi' },
                        ResourceId: { Ref: 'MyResource' },
                        HttpMethod: 'GET',
                        Integration: {
                            Type: 'AWS_PROXY',
                            Uri: {
                                'Fn::Sub':
                                    'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MyFuncLambdaFunction.Arn}/invocations',
                            },
                        },
                    },
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});
        const indexContent = fs.readFileSync(result.outputPath, 'utf-8');
        const apiGwContent = readApiGatewayFile();

        // lambdas object kept for passing to ApiGatewayResources
        expect(indexContent).toContain('const lambdas = lambdaFunctions(this, props)');
        expect(indexContent).toContain('new ApiGatewayResources(this, lambdas)');

        // api-gateway.ts imports lambdaFunctions type and destructures the lambda
        expect(apiGwContent).toContain('import type { lambdaFunctions }');
        expect(apiGwContent).toContain('new LambdaIntegration(myFunc)');
    });

    it('should pass SQS queues to ApiGatewayResources when AwsIntegration (SQS) is present', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyQueue: { Type: 'AWS::SQS::Queue', Properties: {} },
                MyRestApi: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
                MyResource: {
                    Type: 'AWS::ApiGateway::Resource',
                    Properties: {
                        RestApiId: { Ref: 'MyRestApi' },
                        ParentId: { 'Fn::GetAtt': ['MyRestApi', 'RootResourceId'] },
                        PathPart: 'messages',
                    },
                },
                MyMethod: {
                    Type: 'AWS::ApiGateway::Method',
                    Properties: {
                        RestApiId: { Ref: 'MyRestApi' },
                        ResourceId: { Ref: 'MyResource' },
                        HttpMethod: 'POST',
                        Integration: {
                            Type: 'AWS',
                            Uri: {
                                'Fn::Sub':
                                    'arn:aws:apigateway:${AWS::Region}:sqs:path/${AWS::AccountId}/${MyQueue.QueueName}',
                            },
                        },
                    },
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});
        const indexContent = fs.readFileSync(result.outputPath, 'utf-8');
        const apiGwContent = readApiGatewayFile();

        // index.ts passes the queue var to ApiGatewayResources
        expect(indexContent).toContain('new ApiGatewayResources(this, undefined, { myQueue })');

        // api-gateway.ts has sqs import and queues param with destructuring
        expect(apiGwContent).toContain('import * as sqs from "aws-cdk-lib/aws-sqs"');
        expect(apiGwContent).toContain('queues?');
        expect(apiGwContent).toContain('queues ??');
        expect(apiGwContent).toContain('new AwsIntegration(');
    });

    it('should pass state machines to ApiGatewayResources when StepFunctionsIntegration is present', () => {
        // MyStateMachine is intentionally absent from Resources — the test focuses on the
        // API GW wiring, not on state machine construct generation.
        const template: CloudFormationTemplate = {
            Resources: {
                MyRestApi: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
                MyResource: {
                    Type: 'AWS::ApiGateway::Resource',
                    Properties: {
                        RestApiId: { Ref: 'MyRestApi' },
                        ParentId: { 'Fn::GetAtt': ['MyRestApi', 'RootResourceId'] },
                        PathPart: 'execute',
                    },
                },
                MyMethod: {
                    Type: 'AWS::ApiGateway::Method',
                    Properties: {
                        RestApiId: { Ref: 'MyRestApi' },
                        ResourceId: { Ref: 'MyResource' },
                        HttpMethod: 'POST',
                        Integration: {
                            Type: 'AWS',
                            Uri: {
                                'Fn::Sub':
                                    'arn:aws:apigateway:${AWS::Region}:states:action/StartExecution',
                            },
                            RequestTemplates: {
                                'application/json': {
                                    'Fn::Sub': '{"stateMachineArn": "${MyStateMachine.Arn}"}',
                                },
                            },
                        },
                    },
                },
            },
        };
        const result = generateConstructs(template, false, tmpDir, {});
        const indexContent = fs.readFileSync(result.outputPath, 'utf-8');
        const apiGwContent = readApiGatewayFile();

        // index.ts passes the state machine var to ApiGatewayResources
        expect(indexContent).toContain(
            'new ApiGatewayResources(this, undefined, undefined, { myStateMachine })'
        );

        // api-gateway.ts has sfn import and stateMachines param with destructuring
        expect(apiGwContent).toContain('import * as sfn from "aws-cdk-lib/aws-stepfunctions"');
        expect(apiGwContent).toContain('stateMachines?');
        expect(apiGwContent).toContain('stateMachines ??');
        expect(apiGwContent).toContain('StepFunctionsIntegration.startExecution(myStateMachine)');
    });
});
