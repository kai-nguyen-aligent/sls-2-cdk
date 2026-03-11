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
    /** Path to the generated serverless-sub.yml */
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
// Pipeline / Orchestration Types
// ============================================================

export interface StepOutput<T> {
    stepName: string;
    success: boolean;
    data: T;
    durationMs: number;
    error?: string | undefined;
}
