// core-tools.ts
import * as fs from "fs/promises";
import * as path from "path";
import type { DirectoryItem } from "../types/types.js";
import { defineChatSessionFunction } from "node-llama-cpp";

// ============================================================================
// TOOL 1: READ_FILE
// ============================================================================
export const readFileTool = defineChatSessionFunction({
  description: "Read the contents of a file from the filesystem",
  params: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the file",
      },
      context: {
        type: "object",
        description: "Current model context",
      },
    },
    required: ["path"],
  },

  async handler(params: { path: string; context: any }) {
    console.log(params);
    try {
      const cwd = process.cwd();
      // Security: Resolve to absolute path and check if allowed
      const absolutePath = path.resolve(cwd, params.path);

      if (!isPathAllowed(absolutePath, [cwd])) {
        return {
          success: false,
          error: `Access denied: ${params.path} is outside allowed directories`,
        };
      }

      // Check if file exists
      const stats = await fs.stat(absolutePath);

      if (!stats.isFile()) {
        return {
          success: false,
          error: `${params.path} is not a file`,
        };
      }

      // Check file size limit
      if (stats.size > params.context.maxFileSize) {
        return {
          success: false,
          error: `File too large: ${formatBytes(stats.size)} exceeds limit of ${formatBytes(params.context.maxFileSize)}`,
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
          lastModified: stats.mtime,
        },
      };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return {
          success: false,
          error: `File not found: ${params.path}`,
        };
      }

      if (error.code === "EACCES") {
        return {
          success: false,
          error: `Permission denied: ${params.path}`,
        };
      }

      return {
        success: false,
        error: `Failed to read file: ${error.message}`,
      };
    }
  },
});

// ============================================================================
// TOOL 2: LIST_DIRECTORY
// ============================================================================

export const listDirectoryTool = defineChatSessionFunction({
  description: "List files and directories in a given path",
  params: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list",
        default: ".",
      },
      recursive: {
        type: "boolean",
        description: "Recursively list subdirectories",
        default: false,
      },
      maxDepth: {
        type: "number",
        description: "Maximum depth for recursive listing",
        default: 3,
      },
      showHidden: {
        type: "boolean",
        description: "Include hidden files (starting with .)",
        default: false,
      },
    },
  },

  async handler(params: {
    path?: string;
    recursive?: boolean;
    maxDepth?: number;
    showHidden?: boolean;
  }) {
    try {
      const cwd = process.cwd();

      const targetPath = path.resolve(cwd, params.path || ".");

      if (!isPathAllowed(targetPath, [cwd])) {
        return {
          success: false,
          error: `Access denied: ${params.path} is outside allowed directories`,
        };
      }

      // Check if directory exists
      const stats = await fs.stat(targetPath);
      if (!stats.isDirectory()) {
        return {
          success: false,
          error: `${params.path} is not a directory`,
        };
      }

      // List directory contents
      const items = await listDirectoryRecursive(
        targetPath,
        params.recursive || false,
        params.maxDepth || 3,
        params.showHidden || false,
        0,
      );

      return {
        success: true,
        data: items,
        metadata: {
          path: targetPath,
          totalItems: items.length,
          directories: items.filter((i) => i.type === "directory").length,
          files: items.filter((i) => i.type === "file").length,
        },
      };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return {
          success: false,
          error: `Directory not found: ${params.path}`,
        };
      }

      if (error.code === "EACCES") {
        return {
          success: false,
          error: `Permission denied: ${params.path}`,
        };
      }

      return {
        success: false,
        error: `Failed to list directory: ${error.message}`,
      };
    }
  },
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
  currentDepth: number,
): Promise<DirectoryItem[]> {
  const items: DirectoryItem[] = [];

  if (currentDepth > maxDepth) {
    return items;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });

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
      modified,
    } as any);

    // Recurse into subdirectories
    if (recursive && entry.isDirectory()) {
      const subItems = await listDirectoryRecursive(
        fullPath,
        recursive,
        maxDepth,
        showHidden,
        currentDepth + 1,
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

export const CORE_TOOLS = [readFileTool];

const tools = new Map(CORE_TOOLS.map((tool) => [tool.description, tool]));

export const getToolDefinitions = (): string => {
  return Array.from(tools.values())
    .map((tool) => {
      return `${tool.description}: ${tool.description} 
        Parameters: ${JSON.stringify(tool.params, null, 2)}`;
    })
    .join("\n\n");
};
