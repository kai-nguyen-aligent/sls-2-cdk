# sls-2-cdk

A CLI tool that converts [Serverless Framework](https://www.serverless.com/) projects into [AWS CDK](https://aws.amazon.com/cdk/)-ready artifacts. It extracts CloudFormation templates, substitutes variables, generates CDK L2 construct code, and migrates runtime assets for direct integration into an [@aligent/nx-cdk](https://github.com/aligent/nx-plugins) workspace.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
- [Migration Pipeline](#migration-pipeline)
- [Input / Output](#input--output)
- [Supported Resources](#supported-resources)
- [Development](#development)
- [License](#license)

## Features

- **Automated variable substitution** -- replaces external Serverless variable references (`${ssm:...}`, `${env:...}`, `${s3:...}`, etc.) with stable hashed placeholders while preserving local references (`${self:...}`, `${sls:...}`)
- **CloudFormation to CDK L2 construct generation** -- maps 20+ CloudFormation resource types to idiomatic CDK TypeScript code via `ts-morph` AST manipulation
- **Lambda environment variable extraction** -- identifies shared and per-function env vars with intrinsic function resolution
- **Step Function ASL extraction** -- converts inline `DefinitionString` definitions to standalone YAML files
- **SSM parameter injection** -- updates a shared infrastructure stack with `StringParameter.fromStringParameterName` lookups
- **Interactive runtime code migration** -- prompts you to selectively copy source folders, files, and dependencies
- **Service prefix stripping** -- cleans up Serverless naming conventions (e.g. `AcgIntDash`, `Stage`) for readable CDK identifiers
- **Full intermediate output** -- every pipeline step writes a JSON artifact for debugging and auditing

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | >= 22.0.0 |
| pnpm | >= 8 |
| Serverless Framework | 3.x (invoked via `npx serverless@3.39.0`) |
| Destination CDK workspace | Bootstrapped with `@aligent/nx-cdk` |

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd sls-2-cdk

# Install dependencies
pnpm install

# Build
pnpm run build
```

## Usage

```bash
sls-2-cdk migrate [OPTIONS]
```

### Options

| Flag | Alias | Description |
|---|---|---|
| `--input <dir>` | `-i` | Input directory containing `serverless.yml` or `serverless.yaml` |
| `--intermediate <dir>` | `-m` | Directory for intermediate JSON output files (default: `.sls-2-cdk`) |
| `--keep-names` | `-k` | Keep original resource names (e.g. S3 bucket names, DynamoDB table names) |
| `--destination <dir>` | `-d` | Destination `@aligent/nx-cdk` workspace directory |
| `--service-prefix <string>` | `-s` | Service prefix to strip from CDK IDs and variable names (e.g. `sls-int`, `acg-int`) |

When flags are omitted, the CLI prompts for each value interactively.

### Example

```bash
# Fully specified
sls-2-cdk migrate \
  -i ../existing-sls/services/customers \
  -m .sls-2-cdk \
  -d ../out-cdk \
  -s acg-int

# Interactive mode (prompts for all values)
sls-2-cdk migrate
```

## Migration Pipeline

The tool runs a **9-step pipeline**. Each step writes its result to `<intermediate>/step-outputs/` as JSON for traceability.

### Step 1 -- Substitute Variables

Parses `serverless.yml` and any `${file(...)}` referenced files. Replaces external variable expressions with hashed placeholders (`__SLS2CDK_SSM_<hash>__`), creating `-vars-substitution` copies of all affected files.

| Substituted | Preserved |
|---|---|
| `${ssm:...}`, `${s3:...}`, `${cf:...}`, `${env:...}`, `${aws:...}` | `${self:...}`, `${sls:...}`, `${opt:...}`, CloudFormation `!Sub` |

### Step 2 -- Serverless Package

Runs `npx serverless@3.39.0 package --stage dev` against the substituted config to produce a CloudFormation template (`cloudformation-template-update-stack.json`).

### Step 3 -- Build Lambda Environment Map

Scans all `AWS::Lambda::Function` resources in the template. For each function, extracts environment variables and flags intrinsic values (`Ref`, `Fn::GetAtt`, etc.). Variables with identical values across every function are marked as **shared**.

### Step 4 -- Update Shared Stack (SSM Parameters)

Uses `ts-morph` to inject SSM parameter references into the shared infra stack (`libs/infra/src/index.ts`):
- Adds `IStringParameter` / `StringParameter` imports
- Adds properties to `SharedInfraProps` and the stack class
- Injects `StringParameter.fromStringParameterName(...)` assignments in the constructor
- Updates `getProps()` with new SSM references

### Step 5 -- Generate Destination CDK Service

Runs `npx nx g @aligent/nx-cdk:service <name>` in the destination workspace to scaffold a new service.

### Step 6 -- Extract Step Function Definitions

Finds `AWS::StepFunctions::StateMachine` resources, resolves `Fn::Sub` variable substitutions, converts ASL definitions from JSON to YAML, and writes them to `src/infra/step-functions/<name>.asl.yaml`.

### Step 7 -- Generate CDK Constructs

The core step. Converts CloudFormation resources into CDK L2 constructs:

- Maps CloudFormation property names (PascalCase) to CDK (camelCase)
- Handles property expansion (e.g. `VpcConfig` to `vpc` / `vpcSubnets` / `securityGroups`)
- Converts intrinsic functions to `cdk.Fn.*` helpers
- Resolves `Ref` / `Fn::GetAtt` to CDK property accessors
- Generates separate files for Lambda functions and API Gateway resources
- Adds `TODO` and `FIXME` comments for items requiring manual review

### Step 8 -- Migrate Runtime Code

Interactively prompts you to copy runtime source code (folders and files) from the Serverless project to the CDK service. Automatically excludes build artifacts, config files, and lock files.

### Step 9 -- Migrate Dependencies

Reads the source `package.json`, identifies dependencies not present in the destination workspace, and prompts you to select which ones to add.

## Input / Output

### Input

A Serverless Framework project directory containing `serverless.yml` (or `.yaml`) with standard variable references and resource definitions.

### Output

**Intermediate directory** (default `.sls-2-cdk/`):

```
.sls-2-cdk/
  step-outputs/
    01-substitute-variables.json
    02-serverless-package.json
    03-env-map.json
    04-update-shared-stack.json
    05-generate-dest-service.json
    06-extract-state-machine-definitions.json
    07-generate-constructs.json
    08-migrate-runtime-code.json
    09-migrate-dependencies.json
    cloudformation-template.json
  serverless-vars-substitution.yml
  *-vars-substitution.yml
```

**Destination CDK service**:

```
services/<name>/
  src/
    index.ts                        # Main stack class
    infra/
      lambda-functions.ts           # Lambda constructs (if applicable)
      api-gateway.ts                # API Gateway constructs (if applicable)
      step-functions/
        *.asl.yaml                  # Step Function ASL definitions (if applicable)
```

**Shared infra stack** (`libs/infra/src/index.ts`) -- updated with SSM parameter lookups.

## Supported Resources

The following CloudFormation resource types are mapped to CDK L2 constructs:

| CloudFormation Type | CDK Construct |
|---|---|
| `AWS::Lambda::Function` | `lambdaNodejs.NodejsFunction` |
| `AWS::Lambda::LayerVersion` | `lambda.LayerVersion` |
| `AWS::Lambda::EventSourceMapping` | `lambda.EventSourceMapping` |
| `AWS::DynamoDB::Table` | `dynamodb.Table` |
| `AWS::S3::Bucket` | `s3.Bucket` |
| `AWS::StepFunctions::StateMachine` | `StepFunctionFromFile` |
| `AWS::ApiGateway::RestApi` | `apigw.RestApi` |
| `AWS::ApiGateway::Resource` | `apigw.Resource` |
| `AWS::ApiGateway::Method` | `apigw.Method` |
| `AWS::ApiGateway::ApiKey` | `apigw.ApiKey` |
| `AWS::ApiGateway::UsagePlan` | `apigw.UsagePlan` |
| `AWS::ApiGateway::RequestValidator` | `apigw.RequestValidator` |
| `AWS::SQS::Queue` | `sqs.Queue` |
| `AWS::SNS::Topic` | `sns.Topic` |
| `AWS::SNS::Subscription` | `sns.Subscription` |
| `AWS::Events::EventBus` | `events.EventBus` |
| `AWS::Events::Rule` | `events.Rule` |
| `AWS::CloudWatch::Alarm` | `cw.Alarm` |
| `AWS::Logs::MetricFilter` | `logs.MetricFilter` |
| `AWS::Scheduler::Schedule` | `scheduler.CfnSchedule` |
| `AWS::SSM::Parameter` | `ssm.StringParameter` |
| `AWS::SecretsManager::Secret` | `secretsmanager.Secret` |

Resources without an explicit mapping are skipped and reported in the step output.

### Ignored Resources

The following Serverless-managed resources are automatically filtered out:

- `ServerlessDeploymentBucket`
- `ServerlessDeploymentBucketPolicy`
- `IamRoleLambdaExecution`

## Development

### Commands

```bash
pnpm run build            # Clean dist/ and compile TypeScript
pnpm run dev              # Build + run dev CLI
pnpm run dev:e2e          # End-to-end run with sample input
pnpm run test             # Run tests (+ lint via posttest hook)
pnpm run test:watch       # Watch mode
pnpm run test:coverage    # Coverage report
pnpm run lint             # ESLint
```

### Project Structure

```
src/
  commands/migrate.ts       # Main oclif command (CLI entry point)
  steps/                    # 9-step processing pipeline
    substitute-variables.ts
    sls-package.ts
    build-env-map.ts
    update-shared-stack.ts
    generate-constructs.ts
    migrate-runtime-code.ts
    migrate-dependencies.ts
  utils/
    file-io.ts              # File I/O utilities
    workspace.ts            # Nx workspace helpers
    resources/              # Resource-specific generators
      resources-config.ts   # CloudFormation -> CDK mapping config
      state-machine.ts      # Step Function extraction
  types/index.ts            # TypeScript type definitions
  index.ts                  # oclif run export
test/
  steps/                    # Unit tests mirroring src/steps/
  fixtures/                 # YAML and JSON test fixtures
bin/
  run.js                    # Production entry point
  dev.js                    # Development entry point (tsx)
```

### Tech Stack

- **TypeScript 5** (strict mode, ES2024 target, ESM)
- **oclif v4** -- CLI framework
- **ts-morph** -- TypeScript AST manipulation for code generation
- **yaml** -- YAML parsing with document visitor pattern
- **@inquirer/prompts** -- Interactive CLI prompts
- **Vitest 3** -- Testing framework
- **ESLint 9 + Prettier 3** -- via `@aligent/ts-code-standards`

## License

MIT
