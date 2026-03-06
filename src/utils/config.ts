import * as fs from 'node:fs'
import {DEFAULT_CONFIG} from '../types/index.js'
import type {Sls2CdkConfig} from '../types/index.js'

export function loadConfig(configPath?: string): Sls2CdkConfig {
  if (!configPath) {
    return {...DEFAULT_CONFIG}
  }

  const raw = fs.readFileSync(configPath, 'utf-8')
  const userConfig = JSON.parse(raw) as Partial<Sls2CdkConfig>

  return {
    removeResourceIds: [
      ...DEFAULT_CONFIG.removeResourceIds,
      ...(userConfig.removeResourceIds ?? []),
    ],
    removeResourceTypePatterns: [
      ...DEFAULT_CONFIG.removeResourceTypePatterns,
      ...(userConfig.removeResourceTypePatterns ?? []),
    ],
  }
}
