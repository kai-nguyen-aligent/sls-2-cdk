import {execSync} from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'

export interface PackageResult {
  templatePath: string
  serverlessDir: string
}

export function runServerlessPackage(
  servicePath: string,
  stage: string,
): PackageResult {
  try {
    execSync(`npx serverless@3.38.4 package --stage ${stage}`, {
      cwd: servicePath,
      stdio: 'inherit',
      timeout: 300_000,
    })
  } catch (error) {
    throw new Error(
      `serverless package failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const serverlessDir = path.join(servicePath, '.serverless')
  const templatePath = path.join(
    serverlessDir,
    'cloudformation-template-update-stack.json',
  )

  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `Expected CloudFormation template not found at: ${templatePath}. ` +
      'Ensure "serverless package" completed successfully.',
    )
  }

  return {templatePath, serverlessDir}
}
