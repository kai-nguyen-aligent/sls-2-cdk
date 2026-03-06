import { describe, expect, it } from 'vitest';
import { buildResourceMap } from '../../src/steps/build-resource-map.js';
import type { CloudFormationTemplate } from '../../src/types/index.js';

describe('buildResourceMap', () => {
    it('should group resources by type', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                Func1: { Type: 'AWS::Lambda::Function', Properties: { Handler: 'a.handler' } },
                Func2: { Type: 'AWS::Lambda::Function', Properties: { Handler: 'b.handler' } },
                Table1: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'test' } },
            },
        };
        const result = buildResourceMap(template);

        expect(result.byType['AWS::Lambda::Function']).toHaveLength(2);
        expect(result.byType['AWS::DynamoDB::Table']).toHaveLength(1);
        expect(result.summary['AWS::Lambda::Function']).toBe(2);
        expect(result.summary['AWS::DynamoDB::Table']).toBe(1);
        expect(result.totalCount).toBe(3);
    });

    it('should provide flat lookup by logical ID', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: { Type: 'AWS::Lambda::Function', Properties: { Handler: 'x.handler' } },
            },
        };
        const result = buildResourceMap(template);

        expect(result.byLogicalId['MyFunc']).toBeDefined();
        expect(result.byLogicalId['MyFunc'].type).toBe('AWS::Lambda::Function');
        expect(result.byLogicalId['MyFunc'].properties.Handler).toBe('x.handler');
    });

    it('should normalize DependsOn string to array', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: { Type: 'AWS::Lambda::Function', DependsOn: 'MyRole' },
                MyRole: { Type: 'AWS::IAM::Role' },
            },
        };
        const result = buildResourceMap(template);

        expect(result.byLogicalId['MyFunc'].dependsOn).toEqual(['MyRole']);
    });

    it('should normalize DependsOn array', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: { Type: 'AWS::Lambda::Function', DependsOn: ['RoleA', 'RoleB'] },
            },
        };
        const result = buildResourceMap(template);

        expect(result.byLogicalId['MyFunc'].dependsOn).toEqual(['RoleA', 'RoleB']);
    });

    it('should return empty dependsOn when not set', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: { Type: 'AWS::Lambda::Function' },
            },
        };
        const result = buildResourceMap(template);

        expect(result.byLogicalId['MyFunc'].dependsOn).toEqual([]);
    });

    it('should handle empty Resources', () => {
        const template: CloudFormationTemplate = { Resources: {} };
        const result = buildResourceMap(template);

        expect(result.totalCount).toBe(0);
        expect(Object.keys(result.byType)).toHaveLength(0);
        expect(Object.keys(result.byLogicalId)).toHaveLength(0);
    });

    it('should include condition when present', () => {
        const template: CloudFormationTemplate = {
            Resources: {
                MyFunc: { Type: 'AWS::Lambda::Function', Condition: 'IsProd' },
            },
        };
        const result = buildResourceMap(template);

        expect(result.byLogicalId['MyFunc'].condition).toBe('IsProd');
    });
});
