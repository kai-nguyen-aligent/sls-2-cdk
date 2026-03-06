// ============================================================
// Configuration
// ============================================================

export interface Sls2CdkConfig {
    /** CloudFormation logical IDs to remove (exact match) */
    removeResourceIds: string[];
    /**
     * CloudFormation resource Type patterns to remove.
     * Supports trailing wildcard: "Custom::*" matches "Custom::Anything"
     */
    removeResourceTypePatterns: string[];
}

export const DEFAULT_CONFIG: Sls2CdkConfig = {
    removeResourceIds: ['ServerlessDeploymentBucket', 'ServerlessDeploymentBucketPolicy'],
    removeResourceTypePatterns: ['Custom::*'],
};

// ============================================================
// SSM Substitution Types
// ============================================================

export interface SsmReference {
    /** The full original expression, e.g. "${ssm:/app/${sls:stage}/db~true}" */
    original: string;
    /** The path with inner variables left as-is, e.g. "/app/${sls:stage}/db" */
    path: string;
    /** Whether ~true was present (decrypt flag) */
    decrypt: boolean;
    /** Region override if present */
    region?: string | undefined;
    /** Whether (raw) was specified */
    raw: boolean;
    /** Whether (noDecrypt) was specified */
    noDecrypt: boolean;
    /** The placeholder that replaced it, e.g. "__SLS2CDK_SSM_0__" */
    placeholder: string;
}

export interface SsmSubstitutionResult {
    /** The modified serverless.yml content with SSM refs replaced */
    modifiedContent: string;
    /** All SSM references found and their placeholder mappings */
    substitutions: SsmReference[];
    /** Count of substitutions made */
    count: number;
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
// Pipeline / Orchestration Types
// ============================================================

export interface StepOutput<T> {
    stepName: string;
    success: boolean;
    data: T;
    durationMs: number;
    error?: string | undefined;
}
