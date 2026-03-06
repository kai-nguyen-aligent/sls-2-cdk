import * as fs from 'node:fs'
import type {SsmReference, SsmSubstitutionResult} from '../types/index.js'

interface SsmMatch {
  start: number
  end: number
  fullMatch: string
}

/**
 * Scans content for ${ssm...} references, handling nested ${} by counting brace depth.
 */
function findSsmReferences(content: string): SsmMatch[] {
  const results: SsmMatch[] = []
  const marker = '${ssm'
  let searchFrom = 0

  while (searchFrom < content.length) {
    const idx = content.indexOf(marker, searchFrom)
    if (idx === -1) break

    let depth = 0
    let endIdx = -1
    for (let i = idx; i < content.length; i++) {
      if (content[i] === '{') depth++
      if (content[i] === '}') {
        depth--
        if (depth === 0) {
          endIdx = i
          break
        }
      }
    }

    if (endIdx !== -1) {
      results.push({
        start: idx,
        end: endIdx + 1,
        fullMatch: content.slice(idx, endIdx + 1),
      })
      searchFrom = endIdx + 1
    } else {
      searchFrom = idx + marker.length
    }
  }

  return results
}

/**
 * Parses a single SSM reference string into structured data.
 *
 * Handles:
 *   ${ssm:/path}
 *   ${ssm(us-west-2):/path}
 *   ${ssm(raw):/path}
 *   ${ssm(us-west-2, raw):/path~true}
 *   ${ssm:/app/${sls:stage}/db~true}
 */
function parseSsmReference(fullMatch: string): Omit<SsmReference, 'placeholder'> {
  // Strip outer ${ and }
  const inner = fullMatch.slice(2, -1)

  const optionsRegex = /^ssm(?:\(([^)]*)\))?:(.+)$/s
  const match = inner.match(optionsRegex)
  if (!match) {
    throw new Error(`Unable to parse SSM reference: ${fullMatch}`)
  }

  const optionsStr = match[1] as string | undefined
  let pathWithFlags = match[2]
  if (!pathWithFlags) {
    throw new Error(`Unable to parse SSM path from: ${fullMatch}`)
  }

  let region: string | undefined
  let raw = false
  let noDecrypt = false
  if (optionsStr) {
    const parts = optionsStr.split(',').map((s) => s.trim())
    for (const part of parts) {
      if (part === 'raw') raw = true
      else if (part === 'noDecrypt') noDecrypt = true
      else region = part
    }
  }

  let decrypt = false
  if (pathWithFlags.endsWith('~true')) {
    decrypt = true
    pathWithFlags = pathWithFlags.slice(0, -5)
  }

  return {
    original: fullMatch,
    path: pathWithFlags,
    decrypt,
    region,
    raw,
    noDecrypt,
  }
}

export function substituteSSM(
  serverlessYmlPath: string,
): SsmSubstitutionResult {
  const originalContent = fs.readFileSync(serverlessYmlPath, 'utf-8')

  // Back up the original
  const backupPath = serverlessYmlPath + '.sls2cdk.bak'
  fs.writeFileSync(backupPath, originalContent)

  const refs = findSsmReferences(originalContent)

  if (refs.length === 0) {
    return {
      modifiedContent: originalContent,
      substitutions: [],
      count: 0,
    }
  }

  // Parse and assign placeholders
  const substitutions: SsmReference[] = refs.map((ref, index) => {
    const parsed = parseSsmReference(ref.fullMatch)
    return {
      ...parsed,
      placeholder: `__SLS2CDK_SSM_${index}__`,
    }
  })

  // Replace from end to start to preserve string indices
  let modifiedContent = originalContent
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    const sub = substitutions[i]!
    modifiedContent =
      modifiedContent.slice(0, ref.start) +
      sub.placeholder +
      modifiedContent.slice(ref.end)
  }

  // Write modified file in-place so `serverless package` reads it
  fs.writeFileSync(serverlessYmlPath, modifiedContent)

  return {
    modifiedContent,
    substitutions,
    count: substitutions.length,
  }
}

export function restoreServerlessYml(serverlessYmlPath: string): void {
  const backupPath = serverlessYmlPath + '.sls2cdk.bak'
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, serverlessYmlPath)
    fs.unlinkSync(backupPath)
  }
}
