import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {substituteSSM, restoreServerlessYml} from '../../src/steps/substitute-ssm.js'

describe('substituteSSM', () => {
  let tmpDir: string
  let ymlPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sls2cdk-test-'))
    ymlPath = path.join(tmpDir, 'serverless.yml')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('should substitute a basic SSM reference', () => {
    fs.writeFileSync(ymlPath, 'DB_HOST: ${ssm:/myapp/db-host}')
    const result = substituteSSM(ymlPath)

    expect(result.count).toBe(1)
    expect(result.substitutions[0].path).toBe('/myapp/db-host')
    expect(result.substitutions[0].decrypt).toBe(false)
    expect(result.substitutions[0].placeholder).toBe('__SLS2CDK_SSM_0__')
    expect(result.modifiedContent).toBe('DB_HOST: __SLS2CDK_SSM_0__')
  })

  it('should handle ~true decrypt flag', () => {
    fs.writeFileSync(ymlPath, 'SECRET: ${ssm:/myapp/secret~true}')
    const result = substituteSSM(ymlPath)

    expect(result.substitutions[0].decrypt).toBe(true)
    expect(result.substitutions[0].path).toBe('/myapp/secret')
  })

  it('should handle region override', () => {
    fs.writeFileSync(ymlPath, 'KEY: ${ssm(us-west-2):/shared/api-key}')
    const result = substituteSSM(ymlPath)

    expect(result.substitutions[0].region).toBe('us-west-2')
    expect(result.substitutions[0].path).toBe('/shared/api-key')
  })

  it('should handle raw flag', () => {
    fs.writeFileSync(ymlPath, 'CFG: ${ssm(raw):/myapp/config}')
    const result = substituteSSM(ymlPath)

    expect(result.substitutions[0].raw).toBe(true)
    expect(result.substitutions[0].path).toBe('/myapp/config')
  })

  it('should handle noDecrypt flag', () => {
    fs.writeFileSync(ymlPath, 'VAL: ${ssm(noDecrypt):/myapp/val}')
    const result = substituteSSM(ymlPath)

    expect(result.substitutions[0].noDecrypt).toBe(true)
  })

  it('should handle combined region + raw', () => {
    fs.writeFileSync(ymlPath, 'VAL: ${ssm(eu-west-1, raw):/myapp/val}')
    const result = substituteSSM(ymlPath)

    expect(result.substitutions[0].region).toBe('eu-west-1')
    expect(result.substitutions[0].raw).toBe(true)
  })

  it('should handle nested ${sls:stage} in SSM path', () => {
    fs.writeFileSync(ymlPath, 'DB: ${ssm:/app/${sls:stage}/db}')
    const result = substituteSSM(ymlPath)

    expect(result.count).toBe(1)
    expect(result.substitutions[0].path).toBe('/app/${sls:stage}/db')
  })

  it('should handle nested ${self:custom} with decrypt', () => {
    fs.writeFileSync(ymlPath, 'SEC: ${ssm:/app/${self:custom.env}/secret~true}')
    const result = substituteSSM(ymlPath)

    expect(result.substitutions[0].path).toBe('/app/${self:custom.env}/secret')
    expect(result.substitutions[0].decrypt).toBe(true)
  })

  it('should handle multiple nesting levels', () => {
    fs.writeFileSync(ymlPath, 'VAL: ${ssm:/a/${sls:stage}/${self:custom.x}/b}')
    const result = substituteSSM(ymlPath)

    expect(result.count).toBe(1)
    expect(result.substitutions[0].path).toBe('/a/${sls:stage}/${self:custom.x}/b')
  })

  it('should find multiple SSM refs in one file', () => {
    const content = [
      'DB_HOST: ${ssm:/myapp/db-host}',
      'DB_PASS: ${ssm:/myapp/db-pass~true}',
      'API_KEY: ${ssm(us-west-2):/shared/key}',
    ].join('\n')
    fs.writeFileSync(ymlPath, content)
    const result = substituteSSM(ymlPath)

    expect(result.count).toBe(3)
    expect(result.substitutions[0].placeholder).toBe('__SLS2CDK_SSM_0__')
    expect(result.substitutions[1].placeholder).toBe('__SLS2CDK_SSM_1__')
    expect(result.substitutions[2].placeholder).toBe('__SLS2CDK_SSM_2__')
  })

  it('should return count 0 when no SSM refs exist', () => {
    fs.writeFileSync(ymlPath, 'service: my-service\nprovider:\n  name: aws')
    const result = substituteSSM(ymlPath)

    expect(result.count).toBe(0)
    expect(result.substitutions).toHaveLength(0)
  })

  it('should create a backup file', () => {
    const original = 'DB: ${ssm:/myapp/db}'
    fs.writeFileSync(ymlPath, original)
    substituteSSM(ymlPath)

    const backupPath = ymlPath + '.sls2cdk.bak'
    expect(fs.existsSync(backupPath)).toBe(true)
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(original)
  })

  it('should write modified content to the yml file', () => {
    fs.writeFileSync(ymlPath, 'DB: ${ssm:/myapp/db}')
    substituteSSM(ymlPath)

    const written = fs.readFileSync(ymlPath, 'utf-8')
    expect(written).toBe('DB: __SLS2CDK_SSM_0__')
  })

  it('should restore the original file via restoreServerlessYml', () => {
    const original = 'DB: ${ssm:/myapp/db}'
    fs.writeFileSync(ymlPath, original)
    substituteSSM(ymlPath)
    restoreServerlessYml(ymlPath)

    expect(fs.readFileSync(ymlPath, 'utf-8')).toBe(original)
    expect(fs.existsSync(ymlPath + '.sls2cdk.bak')).toBe(false)
  })

  it('should handle SSM ref inside YAML quoted string', () => {
    fs.writeFileSync(ymlPath, 'DB: "${ssm:/myapp/db}"')
    const result = substituteSSM(ymlPath)

    expect(result.count).toBe(1)
    expect(result.modifiedContent).toBe('DB: "__SLS2CDK_SSM_0__"')
  })
})
