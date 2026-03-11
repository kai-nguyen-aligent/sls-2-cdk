import { confirm, input } from '@inquirer/prompts';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MigrateRuntimeCodeResult, RuntimeItem } from '../types/index.js';

const IGNORE_DIRS = new Set(['node_modules', '.serverless', '.build', 'dist']);

const IGNORE_FILES = new Set([
    'serverless.yml',
    'serverless.yaml',
    'serverless-sub.yml',
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'tsconfig.json',
]);

/**
 * Discovers runtime items (folders and files) next to serverless.yml
 * that are candidates for migration to the CDK service.
 */
function discoverRuntimeItems(servicePath: string): RuntimeItem[] {
    const entries = fs.readdirSync(servicePath, { withFileTypes: true });
    const items: RuntimeItem[] = [];

    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        if (entry.isDirectory() && !IGNORE_DIRS.has(entry.name)) {
            items.push({ name: entry.name, type: 'folder' });
        } else if (entry.isFile() && !IGNORE_FILES.has(entry.name)) {
            items.push({ name: entry.name, type: 'file' });
        }
    }

    return items.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

/**
 * Copies runtime code from the Serverless project to the CDK destination.
 *
 * - Folders are copied to their confirmed destinations (map of folder name -> resolved path).
 * - Files (next to serverless.yml) are copied to `fileDestination` (typically the workspace root).
 */
function copyRuntimeCode(
    servicePath: string,
    folderDestinations: Record<string, string>,
    files: string[],
    fileDestination: string
): Omit<MigrateRuntimeCodeResult, 'items'> {
    const copiedFolders: string[] = [];
    const copiedFiles: string[] = [];

    for (const [folderName, dest] of Object.entries(folderDestinations)) {
        const src = path.join(servicePath, folderName);
        fs.cpSync(src, dest, { recursive: true });
        copiedFolders.push(dest);
    }

    for (const fileName of files) {
        const src = path.join(servicePath, fileName);
        const dest = path.join(fileDestination, fileName);
        fs.copyFileSync(src, dest);
        copiedFiles.push(dest);
    }

    return { copiedFolders, copiedFiles };
}

/**
 * Discovers runtime code next to serverless.yml, prompts the user
 * for confirmation, and copies items to the CDK service destination.
 */
export async function migrateRuntimeCode(
    servicePath: string,
    generatedServicePath: string
): Promise<MigrateRuntimeCodeResult> {
    const items = discoverRuntimeItems(servicePath);

    if (items.length === 0) {
        return { copiedFolders: [], copiedFiles: [], items };
    }

    const shouldMigrate = await confirm({
        message: 'Would you like to migrate runtime code to the CDK service?',
        default: true,
    });

    if (!shouldMigrate) {
        return { copiedFolders: [], copiedFiles: [], items };
    }

    const folders = items.filter(i => i.type === 'folder').map(f => f.name);
    const files = items.filter(i => i.type === 'file').map(f => f.name);

    const folderDestinations: Record<string, string> = {};
    for (const folder of folders) {
        const defaultDest = path.join(generatedServicePath, folder);
        const dest = await input({
            message: `Destination for folder "${folder}":`,
            default: defaultDest,
        });
        folderDestinations[folder] = path.resolve(dest);
    }

    const result = copyRuntimeCode(servicePath, folderDestinations, files, generatedServicePath);

    return { ...result, items };
}
