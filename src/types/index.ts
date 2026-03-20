// ============================================================
// Variable Substitution Types
// ============================================================

/** Known Serverless Framework variable types that get substituted */
export type VariableType = 'ssm' | 's3' | 'cf' | 'env' | 'aws' | 'ignore';

export type VariableSubstitutions = Record<
    string,
    {
        /** The placeholder that replaced it, e.g. "__SLS2CDK_VAR_VALUE__" */
        placeholder: string;
        /** The full matched variable */
        fullMatch: string;
        /** The detected variable type */
        variableType: VariableType;
        /** Total count of substitutions */
        count: number;
    }
>;

export interface SubstituteVariablesResult {
    /** All substitutions made across all files */
    substitutions: VariableSubstitutions;
    /** Total count of substitutions */
    count: number;
    /** All generated -sub files (for cleanup) */
    subFiles: string[];
    /** Path to the generated serverless-vars-substitution.yml */
    serverlessSubPath: string;
}

// ============================================================
// CloudFormation Template Types
// ============================================================

export interface CloudFormationResource {
    Type: string;
    Properties?: Record<string, unknown> | undefined;
    DependsOn?: string | string[] | undefined;
    Condition?: string | undefined;
    Metadata?: Record<string, unknown> | undefined;
    [key: string]: unknown;
}

export interface CloudFormationTemplate {
    AWSTemplateFormatVersion?: string | undefined;
    Description?: string | undefined;
    Parameters?: Record<string, unknown> | undefined;
    Conditions?: Record<string, unknown> | undefined;
    Resources: Record<string, CloudFormationResource>;
    Outputs?: Record<string, unknown> | undefined;
    Mappings?: Record<string, unknown> | undefined;
}

// ============================================================
// Resource Removal Types
// ============================================================

export interface RemovedResource {
    logicalId: string;
    type: string;
    reason: 'id_match' | 'type_pattern_match';
    matchedPattern: string;
}

export interface RemoveResourcesResult {
    template: CloudFormationTemplate;
    removed: RemovedResource[];
    remainingCount: number;
}

// ============================================================
// Resource Map Types
// ============================================================

export interface MappedResource {
    logicalId: string;
    type: string;
    properties: Record<string, unknown>;
    dependsOn: string[];
    condition?: string | undefined;
}

export interface ResourceMap {
    byType: Record<string, MappedResource[]>;
    byLogicalId: Record<string, MappedResource>;
    summary: Record<string, number>;
    totalCount: number;
}

// ============================================================
// Lambda Environment Variable Map Types
// ============================================================

export interface EnvVarEntry {
    name: string;
    value: unknown;
    isIntrinsic: boolean;
    intrinsicType?: string | undefined;
}

export interface LambdaEnvVars {
    logicalId: string;
    functionName?: string | undefined;
    handler?: string | undefined;
    runtime?: string | undefined;
    variables: EnvVarEntry[];
}

export interface LambdaEnvMap {
    functions: LambdaEnvVars[];
    allUniqueVarNames: string[];
    sharedVariables: EnvVarEntry[];
    functionCount: number;
}

// ============================================================
// Runtime Code Migration Types
// ============================================================

export interface RuntimeItem {
    /** Name of the file or folder */
    name: string;
    /** Whether this is a folder or a file */
    type: 'folder' | 'file';
}

export interface MigrateRuntimeCodeResult {
    items: RuntimeItem[];
    /** Folders that were copied */
    copiedFolders: string[];
    /** Files that were copied */
    copiedFiles: string[];
}

// ============================================================
// CDK Construct Generation Types
// ============================================================

export interface CdkMapping {
    /** CDK module path, e.g. 'aws-cdk-lib/aws-lambda' */
    cdkModule: string;
    /** CDK import alias, e.g. 'lambda' */
    importAlias: string;
    /** CDK construct class name, e.g. 'NodejsFunction' */
    className: string;
    /**
     * CloudFormation property key that holds the resource's explicit name, per resource type.
     * Omitted when `keepNames` is false so CDK can auto-generate names.
     */
    cfnNameProp: string;
    /**
     * CloudFormation properties that are irrelevant to their CDK L2 counterpart and should
     * be dropped during construct generation (e.g. `Code` / `Handler` on Lambda, which
     * NodejsFunction derives from the entry-point path instead).
     */
    omitProps: Set<string>;
    /**
     * Per-property transformation functions applied before serialisation.
     * Keys are CloudFormation property names (PascalCase). Return a `RawTs`
     * instance to emit a verbatim TypeScript expression (e.g. `Duration.seconds(90)`).
     * Only applied when the property is present; non-numeric values should be passed through.
     */
    propTransforms?: Map<string, (value: unknown) => unknown>;
}

export interface CdkIdMapping {
    /** CloudFormation logical ID of the resource (e.g. `MyTestLambdaFunction`). */
    cfnLogicalId: string;
    /** CDK construct id, e.g. 'MyTest' */
    cdkId: string;
}

export interface GeneratedResource {
    logicalId: string;
    cfnType: string;
    cdkModule: string;
    cdkClass: string;
}

export interface SkippedResource {
    logicalId: string;
    cfnType: string;
    reason: string;
}

export interface GenerateConstructsResult {
    /** Absolute path to the generated construct file */
    outputPath: string;
    /** Resources that were successfully mapped to CDK constructs */
    generated: GeneratedResource[];
    /** Resources that were skipped (unsupported type) */
    skipped: SkippedResource[];
    /** Count of generated constructs */
    generatedCount: number;
    /** Count of skipped resources */
    skippedCount: number;
}

// ============================================================
// Shared Stack Update Types
// ============================================================

export interface SsmParameter {
    /** The original Serverless variable expression, e.g. `${ssm:/my/param}` */
    expression: string;
    /** The extracted SSM path, e.g. `/my/param` */
    ssmPath: string;
    /** camelCase identifier derived from the path, e.g. `myParam` */
    varName: string;
    /** PascalCase CDK construct ID, e.g. `MyParam` */
    cdkId: string;
}

export interface UpdateSharedStackResult {
    /** Absolute path to the updated shared stack file */
    outputPath: string;
    /** SSM parameters extracted from the Serverless substitutions */
    ssmParameters: SsmParameter[];
    /** Count of SSM parameters added */
    ssmCount: number;
}

// ============================================================
// Step Function Definition Extraction Types
// ============================================================

export interface StateMachineSubstitution {
    /** camelCase CDK variable name, used as placeholder key in YAML and CDK reference */
    cdkVarName: string;
    /** CloudFormation logical ID of the referenced resource */
    refLogicalId: string;
    /** Whether the referenced resource is a Lambda function */
    isLambda: boolean;
}

export interface StateMachineDefinitionInfo {
    /** Absolute path to the written YAML ASL definition file */
    yamlPath: string;
    /** Substitutions extracted from the Fn::Sub DefinitionString */
    substitutions: StateMachineSubstitution[];
}

export interface ExtractStateMachineDefinitionsResult {
    /** Map of CloudFormation logical ID to definition info */
    definitions: Record<string, StateMachineDefinitionInfo>;
    /** Number of state machine definitions extracted */
    count: number;
}

// ============================================================
// Pipeline / Orchestration Types
// ============================================================

export interface StepOutput<T> {
    stepName: string;
    success: boolean;
    data: T;
    durationMs: number;
    error?: string | undefined;
}
