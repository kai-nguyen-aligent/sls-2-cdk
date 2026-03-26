import { checkbox, confirm } from '@inquirer/prompts';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MigrateDependenciesResult } from '../types/index.js';

interface PackageJson {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    [key: string]: unknown;
}

function readPackageJson(filePath: string): PackageJson {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as PackageJson;
}

/**
 * Walks up the directory tree from `startDir` looking for the first directory
 * that contains an `nx.json` file. Returns that directory path, or `null` if
 * the filesystem root is reached without finding one.
 */
function findNxWorkspaceRoot(startDir: string): string | null {
    let current = startDir;
    while (true) {
        if (fs.existsSync(path.join(current, 'nx.json'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

/**
 * Resolves the package.json to use as the dependency source.
 *
 * If `servicePath` contains a `project.json` and its `package.json` has no
 * dependencies or devDependencies, this is likely a project inside an Nx
 * monorepo. In that case, walk up the tree to find the workspace root
 * (identified by `nx.json`) and return the `package.json` beside it.
 */
function resolveSourcePackageJson(
    servicePath: string,
    srcPkg: PackageJson
): { pkgPath: string; pkg: PackageJson } {
    const hasDeps =
        Object.keys(srcPkg.dependencies ?? {}).length > 0 ||
        Object.keys(srcPkg.devDependencies ?? {}).length > 0;
    const hasProjectJson = fs.existsSync(path.join(servicePath, 'project.json'));

    if (!hasDeps && hasProjectJson) {
        const wsRoot = findNxWorkspaceRoot(servicePath);
        if (wsRoot) {
            const wsPkgPath = path.join(wsRoot, 'package.json');
            if (fs.existsSync(wsPkgPath)) {
                return { pkgPath: wsPkgPath, pkg: readPackageJson(wsPkgPath) };
            }
        }
    }

    return { pkgPath: path.join(servicePath, 'package.json'), pkg: srcPkg };
}

function collectNewDeps(
    sourceDeps: Record<string, string>,
    destDeps: Record<string, string>
): { toAdd: Record<string, string>; skipped: string[] } {
    const toAdd: Record<string, string> = {};
    const skipped: string[] = [];

    for (const [name, version] of Object.entries(sourceDeps)) {
        if (name in destDeps) {
            skipped.push(name);
        } else {
            toAdd[name] = version;
        }
    }

    return { toAdd, skipped };
}

async function promptDepsToAdd(
    toAdd: Record<string, string>,
    label: string
): Promise<Record<string, string>> {
    if (Object.keys(toAdd).length === 0) return {};

    const choices = Object.entries(toAdd).map(([name, version]) => ({
        name: `${name}@${version}`,
        value: name,
        checked: true,
    }));

    const selected = await checkbox({
        message: `Select ${label} to migrate:`,
        choices,
    });

    return Object.fromEntries(selected.map(name => [name, toAdd[name]!]));
}

/**
 * Migrates dependencies from a Serverless service's package.json into the
 * destination CDK workspace package.json.
 *
 * - Dependencies already present in the destination are skipped.
 * - The user selects which new dependencies to add via interactive prompts.
 */
export async function migrateDependencies(
    servicePath: string,
    destinationDir: string
): Promise<MigrateDependenciesResult> {
    const srcPkgPath = path.join(servicePath, 'package.json');
    const destPkgPath = path.join(destinationDir, 'package.json');

    if (!fs.existsSync(srcPkgPath)) {
        return { added: {}, skipped: [], addedCount: 0, skippedCount: 0 };
    }

    const { pkg: srcPkg } = resolveSourcePackageJson(servicePath, readPackageJson(srcPkgPath));
    const destPkg = readPackageJson(destPkgPath);

    const srcDeps = srcPkg.dependencies ?? {};
    const srcDevDeps = srcPkg.devDependencies ?? {};
    const destDeps = destPkg.dependencies ?? {};
    const destDevDeps = destPkg.devDependencies ?? {};

    const { toAdd: depsToAdd, skipped: depsSkipped } = collectNewDeps(srcDeps, destDeps);
    const { toAdd: devDepsToAdd, skipped: devDepsSkipped } = collectNewDeps(
        srcDevDeps,
        destDevDeps
    );

    const allSkipped = [...depsSkipped, ...devDepsSkipped];
    const hasNewDeps = Object.keys(depsToAdd).length > 0 || Object.keys(devDepsToAdd).length > 0;

    if (!hasNewDeps) {
        return {
            added: {},
            skipped: allSkipped,
            addedCount: 0,
            skippedCount: allSkipped.length,
        };
    }

    const shouldMigrate = await confirm({
        message: 'Would you like to migrate dependencies to the CDK workspace?',
        default: true,
    });

    if (!shouldMigrate) {
        return {
            added: {},
            skipped: allSkipped,
            addedCount: 0,
            skippedCount: allSkipped.length,
        };
    }

    const selectedDeps = await promptDepsToAdd(depsToAdd, 'dependencies');
    const selectedDevDeps = await promptDepsToAdd(devDepsToAdd, 'devDependencies');

    const added: Record<string, string> = { ...selectedDeps, ...selectedDevDeps };

    if (Object.keys(selectedDeps).length > 0) {
        destPkg.dependencies = { ...destDeps, ...selectedDeps };
    }
    if (Object.keys(selectedDevDeps).length > 0) {
        destPkg.devDependencies = { ...destDevDeps, ...selectedDevDeps };
    }

    fs.writeFileSync(destPkgPath, JSON.stringify(destPkg, null, 2) + '\n', 'utf-8');

    return {
        added,
        skipped: allSkipped,
        addedCount: Object.keys(added).length,
        skippedCount: allSkipped.length,
    };
}
