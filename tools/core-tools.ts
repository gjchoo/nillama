// core-tools.ts
import * as fs from "fs/promises";
import * as path from "path";
import {fileURLToPath} from "url";
import {defineChatSessionFunction} from "node-llama-cpp";
import type {DirectoryItem} from "../types/types.js";


// Types
interface FilePermission {
    path: string,
    access: "read" | "write" | "read_write" | "none",
    recursive: boolean
}

interface PermissionConfig {
    allowlist: FilePermission[],
    agentId: string
}
 
// Load permissions from config file
async function loadPermissions(configPath: string): Promise<PermissionConfig> {
    try {
        const config = await fs.readFile(configPath, "utf-8");
        return JSON.parse(config);
    } catch (error) {
        throw new Error(`Failed to load permissions: ${error}`);
    }
}

// Get permission level for path
function getPermissionLevel(
    targetPath: string,
    permissions: FilePermission[]
): "read" | "write" | "read_write" | "none" {
    const normalized = path.normalize(targetPath);
 
    for (const perm of permissions) {
        const permPath = path.normalize(perm.path);
        const matches = perm.recursive
            ? normalized.startsWith(permPath)
            : normalized === permPath;
 
        if (matches) {
            return perm.access;
        }
    }
 
    return "none";
}

// ============================================================================
// TOOL 1: READ_FILE
// ============================================================================
export const readFileTool = defineChatSessionFunction({
    description: "readFileTool",
    params: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Absolute or relative path to the file"
            },
            context: {
                type: "object",
                description: "Current model context"
            }
        },
        required: ["path"]
    },
    async handler(params: {path: string, context: any}) {
        console.log("\nCore Tool: readFileTool");
        console.log(params);

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);

        try {
            // Security: Resolve to absolute path and check if allowed
            const absolutePath = path.resolve(__dirname, params.path);

            if (!isPathAllowed(absolutePath, [__dirname])) {
                return {
                    success: false,
                    error: `Access denied: ${params.path} is outside allowed directories`
                };
            }

            // Check if file exists
            const stats = await fs.stat(absolutePath);

            if (!stats.isFile()) {
                return {
                    success: false,
                    error: `${params.path} is not a file`
                };
            }

            // Check file size limit
            if (stats.size > params.context.maxFileSize) {
                return {
                    success: false,
                    error: `File too large: ${formatBytes(stats.size)} exceeds limit of ${formatBytes(params.context.maxFileSize)}`
                };
            }

            // Read file content
            const content = await fs.readFile(absolutePath, "utf-8");

            return {
                success: true,
                data: content,
                metadata: {
                    path: absolutePath,
                    size: stats.size,
                    lines: content.split("\n").length,
                    lastModified: stats.mtime
                }
            };
        } catch (error: any) {
            if (error.code === "ENOENT") {
                return {
                    success: false,
                    error: `File not found: ${params.path}`
                };
            }

            if (error.code === "EACCES") {
                return {
                    success: false,
                    error: `Permission denied: ${params.path}`
                };
            }

            return {
                success: false,
                error: `Failed to read file: ${error.message}`
            };
        }
    }
});

// ============================================================================
// TOOL 2: LIST_DIRECTORY
// ============================================================================
export const listDirectoryTool = defineChatSessionFunction({
    description: "listDirectoryTool",
    params: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Directory path to list"
            },
            recursive: {
                type: "boolean",
                description: "Recursively list subdirectories"
            },
            maxDepth: {
                type: "number",
                description: "Maximum depth for recursive listing"
            },
            showHidden: {
                type: "boolean",
                description: "Include hidden files (starting with .)"
            }
        }
    },
    async handler(params: {
        path?: string,
        recursive?: boolean,
        maxDepth?: number,
        showHidden?: boolean
    }) {
        try {
            console.log("\nCore Tool: listDirectoryTool");
            console.log(params);

            const WORKSPACE = process.cwd();

            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const targetPath = path.resolve(__dirname, params.path || ".");

            if (!isPathAllowed(targetPath, [WORKSPACE])) {
                return {
                    success: false,
                    error: `Access denied: ${params.path} is outside allowed directories`
                };
            }

            // Check if directory exists
            const stats = await fs.stat(targetPath);
            if (!stats.isDirectory()) {
                return {
                    success: false,
                    error: `${params.path} is not a directory`
                };
            }

            // List directory contents
            const items = await listDirectoryRecursive(
                targetPath,
                params.recursive || false,
                params.maxDepth || 3,
                params.showHidden || false,
                0
            );

            return {
                success: true,
                data: items,
                metadata: {
                    projectDirectory: WORKSPACE,
                    path: targetPath,
                    totalItems: items.length,
                    directories: items.filter((i) => i.type === "directory").length,
                    files: items.filter((i) => i.type === "file").length
                }
            };
        } catch (error: any) {
            if (error.code === "ENOENT") {
                return {
                    success: false,
                    error: `Directory not found: ${params.path}`
                };
            }

            if (error.code === "EACCES") {
                return {
                    success: false,
                    error: `Permission denied: ${params.path}`
                };
            }

            return {
                success: false,
                error: `Failed to list directory: ${error.message}`
            };
        }
    }
});

// ============================================================================
// TOOL 2: LIST_DIRECTORY
// ============================================================================
export const writeFileTool = ({
    description: "writeFileTool",
    params: {
        type: "object",
        properties: {
            operation: {
                type: "string",
                enum: ["read", "write", "append"],
                description: "File operation type"
            },
            path: {
                type: "string",
                description: "Absolute file path"
            },
            content: {
                type: "string",
                description: "Content to write (required for write/append operations)"
            },
            encoding: {
                type: "string",
                enum: ["utf-8", "base64"],
                description: "Text encoding"
            }
        }
    },
    async handler(params: {
        operation: string,
        path: string,
        content: string,
        encoding: string
    }) {
        const {operation, path: targetPath, content, encoding = "utf-8"} = params;
        const permissionConfig = {allowlist: []};
        try {
            // 1. Validate path
            const normalized = path.normalize(targetPath);
            console.log("Normalised path: " + normalized);
            if (!path.isAbsolute(normalized) || normalized.includes("..")) {
                return {
                    status: "error",
                    error: "Invalid path: directory traversal not allowed"
                };
            }
 
            // 2. Check allowlist
            if (!isPathAllowed(normalized, permissionConfig.allowlist)) {
                return {
                    status: "error",
                    error: "Access denied: path not in allowlist"
                };
            }
 
            // 3. Check operation permissions
            const permLevel = getPermissionLevel(
                normalized,
                permissionConfig.allowlist
            );
 
            if (operation === "read" && !["read", "read_write"].includes(permLevel)) {
                return {
                    status: "error",
                    error: "Permission denied: no read access"
                };
            }
 
            if (
                (operation === "write" || operation === "append") &&
      !["write", "read_write"].includes(permLevel)
            ) {
                return {
                    status: "error",
                    error: "Permission denied: no write access"
                };
            }
 
            // 4. Execute operation
            if (operation === "read") {
                const data = await fs.readFile(normalized, encoding);
                return {
                    status: "success",
                    data,
                    path: normalized
                };
            }
 
            if (operation === "write") {
                const dir = path.dirname(normalized);
                await fs.mkdir(dir, {recursive: true});
                await fs.writeFile(normalized, content || "", encoding);
                return {
                    status: "success",
                    path: normalized
                };
            }
 
            if (operation === "append") {
                await fs.appendFile(normalized, content || "", encoding);
                return {
                    status: "success",
                    path: normalized
                };
            }
 
            return {
                status: "error",
                error: "Unknown operation"
            };
        } catch (error) {
            return {
                status: "error",
                error: `Operation failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
function isPathAllowed(targetPath: string, allowedPaths: string[]): boolean {
    // If no restrictions, allow everything
    if (allowedPaths.length === 0) {
        return true;
    }

    // Check if path is within any allowed directory
    for (const allowedPath of allowedPaths) {
        const relative = path.relative(allowedPath, targetPath);
        // If relative path doesn't start with '..', it's inside allowedPath
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
            return true;
        }
    }

    return false;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

async function listDirectoryRecursive(
    dirPath: string,
    recursive: boolean,
    maxDepth: number,
    showHidden: boolean,
    currentDepth: number
): Promise<DirectoryItem[]> {
    const items: DirectoryItem[] = [];

    if (currentDepth > maxDepth) {
        return items;
    }

    const entries = await fs.readdir(dirPath, {withFileTypes: true});

    for (const entry of entries) {
    // Skip hidden files if not requested
        if (!showHidden && entry.name.startsWith(".")) {
            continue;
        }

        const fullPath = path.join(dirPath, entry.name);
        let itemType: DirectoryItem["type"] = "other";
        let size: number | undefined;
        let modified: Date | undefined;

        try {
            const stats = await fs.stat(fullPath);

            if (entry.isFile()) {
                itemType = "file";
                size = stats.size;
            } else if (entry.isDirectory()) {
                itemType = "directory";
            } else if (entry.isSymbolicLink()) {
                itemType = "symlink";
            }

            modified = stats.mtime;
        } catch {
            // Skip items we can't stat
            continue;
        }

        items.push({
            name: entry.name,
            path: fullPath,
            type: itemType,
            size,
            modified
        } as any);

        // Recurse into subdirectories
        if (recursive && entry.isDirectory()) {
            const subItems = await listDirectoryRecursive(
                fullPath,
                recursive,
                maxDepth,
                showHidden,
                currentDepth + 1
            );
            items.push(...subItems);
        }
    }

    return items;
}

// ============================================================================
// EXPORT ALL TOOLS
// ============================================================================

/**
 * Get tool definitions for LLM prompt
 */

export const CORE_TOOLS = [readFileTool, listDirectoryTool, writeFileTool];

const tools = new Map(CORE_TOOLS.map((tool) => [tool.description, tool]));

export const getToolDefinitions = (): string => {
    return Array.from(tools.values())
        .map((tool) => {
            return `${tool.description}: ${tool.description} 
        Parameters: ${JSON.stringify(tool.params, null, 2)}`;
        })
        .join("\n\n");
};

export const getAWSToolDefinitions = (input: any): string => {
    return Array.from(input.values())
        .map((tool) => {
            return `${tool.description}: ${tool.description} 
        Parameters: ${JSON.stringify(tool.execution, null, 2)}`;
        })
        .join("\n\n");
};
 
