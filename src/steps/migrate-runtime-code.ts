import { confirm, input } from '@inquirer/prompts';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MigrateRuntimeCodeResult, RuntimeItem } from '../types/index.js';

const IGNORE_DIRS = new Set(['node_modules', '.serverless', '.build', 'dist']);

const IGNORE_FILES = [
    'serverless*.{yml,yaml}',
    'package.json',
    '*lock*',
    'tsconfig*.json',
    '*.config.{js,mjs,ts,mts}',
    '*-vars-subsitution.{yml,yaml}',
];

function isIgnoredFile(name: string): boolean {
    return IGNORE_FILES.some(pattern => path.matchesGlob(name, pattern));
}

interface FolderCopyOperation {
    src: string;
    dest: string;
}

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
        } else if (entry.isFile() && !isIgnoredFile(entry.name)) {
            items.push({ name: entry.name, type: 'file' });
        }
    }

    return items.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

/**
 * Recursively prompts the user to copy an entire folder or decide per subfolder.
 * Returns a flat list of copy operations to perform.
 */
async function promptFolderCopy(
    srcPath: string,
    folderLabel: string,
    destPath: string
): Promise<FolderCopyOperation[]> {
    const destFolder = await input({
        message: `Destination for folder "${folderLabel}" (relative to ${destPath}):`,
        default: folderLabel,
    });
    const dest = path.join(destPath, destFolder);

    const subFolders = fs
        .readdirSync(srcPath, { withFileTypes: true })
        .filter(e => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'));

    if (subFolders.length === 0) {
        return [{ src: srcPath, dest: path.resolve(dest) }];
    }

    const copyWhole = await confirm({
        message: `Copy entire folder "${folderLabel}"? (No = decide per subfolder)`,
        default: true,
    });

    if (copyWhole) {
        return [{ src: srcPath, dest: path.resolve(dest) }];
    }

    const operations: FolderCopyOperation[] = [];
    for (const subFolder of subFolders) {
        const subOps = await promptFolderCopy(
            path.join(srcPath, subFolder.name),
            `${folderLabel}/${subFolder.name}`,
            destPath
        );
        operations.push(...subOps);
    }
    return operations;
}

/**
 * Copies runtime code from the Serverless project to the CDK destination.
 *
 * - Folders are copied according to the resolved FolderCopyOperation list.
 * - Files (next to serverless.yml) are copied to `fileDestination` (typically the workspace root).
 */
function copyRuntimeCode(
    folderOperations: FolderCopyOperation[],
    servicePath: string,
    files: string[],
    fileDestination: string
): Omit<MigrateRuntimeCodeResult, 'items'> {
    const copiedFolders: string[] = [];
    const copiedFiles: string[] = [];

    for (const { src, dest } of folderOperations) {
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

    const folderOperations: FolderCopyOperation[] = [];
    for (const folder of folders) {
        const ops = await promptFolderCopy(
            path.join(servicePath, folder),
            folder,
            generatedServicePath
        );
        folderOperations.push(...ops);
    }

    const confirmedFiles: string[] = [];
    for (const fileName of files) {
        const shouldCopy = await confirm({
            message: `Copy file "${fileName}" to the CDK service?`,
            default: true,
        });
        if (shouldCopy) {
            confirmedFiles.push(fileName);
        }
    }

    const result = copyRuntimeCode(
        folderOperations,
        servicePath,
        confirmedFiles,
        generatedServicePath
    );

    return { ...result, items };
}
