// core-tools.ts
import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { Tool, ToolExecutionContext, ToolResult } from "../types/types.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// TOOL 1: READ_FILE
// ============================================================================

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file from the filesystem",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the file",
      },
    },
    required: ["path"],
  },

  handler: async (
    params: { path: string },
    context: ToolExecutionContext,
  ): Promise<ToolResult> => {
    try {
      // Security: Resolve to absolute path and check if allowed
      const absolutePath = path.resolve(context.workingDirectory, params.path);

      if (!isPathAllowed(absolutePath, context.allowedPaths)) {
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
      if (stats.size > context.maxFileSize) {
        return {
          success: false,
          error: `File too large: ${formatBytes(stats.size)} exceeds limit of ${formatBytes(context.maxFileSize)}`,
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
};

// ============================================================================
// TOOL 2: WRITE_FILE
// ============================================================================

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file, creating it if it doesn't exist",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path where the file should be written",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
      createDirs: {
        type: "boolean",
        description: "Create parent directories if they don't exist",
        default: true,
      },
    },
    required: ["path", "content"],
  },

  handler: async (
    params: { path: string; content: string; createDirs?: boolean },
    context: ToolExecutionContext,
  ): Promise<ToolResult> => {
    try {
      const absolutePath = path.resolve(context.workingDirectory, params.path);

      if (!isPathAllowed(absolutePath, context.allowedPaths)) {
        return {
          success: false,
          error: `Access denied: ${params.path} is outside allowed directories`,
        };
      }

      // Check content size
      const contentSize = Buffer.byteLength(params.content, "utf-8");
      if (contentSize > context.maxFileSize) {
        return {
          success: false,
          error: `Content too large: ${formatBytes(contentSize)} exceeds limit`,
        };
      }

      // Create parent directories if needed
      if (params.createDirs !== false) {
        const dirPath = path.dirname(absolutePath);
        await fs.mkdir(dirPath, { recursive: true });
      }

      // Check if file already exists (for backup/warning)
      let existedBefore = false;
      let previousSize = 0;
      try {
        const stats = await fs.stat(absolutePath);
        existedBefore = true;
        previousSize = stats.size;
      } catch {
        // File doesn't exist, which is fine
      }

      // Write the file
      await fs.writeFile(absolutePath, params.content, "utf-8");

      return {
        success: true,
        data: {
          path: absolutePath,
          bytesWritten: contentSize,
          linesWritten: params.content.split("\n").length,
        },
        metadata: {
          overwritten: existedBefore,
          previousSize: existedBefore ? previousSize : null,
        },
      };
    } catch (error: any) {
      if (error.code === "EACCES") {
        return {
          success: false,
          error: `Permission denied: Cannot write to ${params.path}`,
        };
      }

      if (error.code === "ENOSPC") {
        return {
          success: false,
          error: "No space left on device",
        };
      }

      return {
        success: false,
        error: `Failed to write file: ${error.message}`,
      };
    }
  },
};

// ============================================================================
// TOOL 3: LIST_DIRECTORY
// ============================================================================

export const listDirectoryTool: Tool = {
  name: "list_directory",
  description: "List files and directories in a given path",
  parameters: {
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

  handler: async (
    params: {
      path?: string;
      recursive?: boolean;
      maxDepth?: number;
      showHidden?: boolean;
    },
    context: ToolExecutionContext,
  ): Promise<ToolResult> => {
    try {
      const targetPath = path.resolve(
        context.workingDirectory,
        params.path || ".",
      );

      if (!isPathAllowed(targetPath, context.allowedPaths)) {
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
};

// Helper for recursive listing
interface DirectoryItem {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  modified?: Date;
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
// TOOL 4: EXECUTE_COMMAND
// ============================================================================

export const executeCommandTool: Tool = {
  name: "execute_command",
  description: "Execute a shell command and return its output",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The command to execute (without shell operators for security)",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Command arguments as array",
        default: [],
      },
      workingDir: {
        type: "string",
        description: "Working directory for command execution",
      },
    },
    required: ["command"],
  },

  handler: async (
    params: {
      command: string;
      args?: string[];
      workingDir?: string;
    },
    context: ToolExecutionContext,
  ): Promise<ToolResult> => {
    try {
      // Security: Validate command against blacklist
      const blacklistedCommands = [
        "rm -rf",
        "dd",
        "mkfs",
        ":(){:|:&};:",
        "sudo",
        "su",
      ];
      const commandLower = params.command.toLowerCase();

      for (const blocked of blacklistedCommands) {
        if (commandLower.includes(blocked)) {
          return {
            success: false,
            error: `Blocked dangerous command: ${blocked}`,
          };
        }
      }

      // Resolve working directory
      const cwd = params.workingDir
        ? path.resolve(context.workingDirectory, params.workingDir)
        : context.workingDirectory;

      if (!isPathAllowed(cwd, context.allowedPaths)) {
        return {
          success: false,
          error: `Access denied: Working directory outside allowed paths`,
        };
      }

      // Execute command with timeout
      const startTime = Date.now();

      const { stdout, stderr } = await Promise.race([
        execFileAsync(params.command, params.args || [], {
          cwd,
          maxBuffer: 1024 * 1024 * 10, // 10MB max output
          env: { ...process.env, PATH: process.env.PATH },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Command timeout")),
            context.commandTimeout,
          ),
        ),
      ]);

      const executionTime = Date.now() - startTime;

      return {
        success: true,
        data: {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: 0,
        },
        metadata: {
          command: params.command,
          args: params.args,
          executionTimeMs: executionTime,
          workingDirectory: cwd,
        },
      };
    } catch (error: any) {
      // Handle command execution errors
      if (error.message === "Command timeout") {
        return {
          success: false,
          error: `Command timed out after ${context.commandTimeout}ms`,
        };
      }

      // execFile errors include stdout/stderr
      return {
        success: false,
        error: error.message,
        data: {
          stdout: error.stdout?.trim() || "",
          stderr: error.stderr?.trim() || "",
          exitCode: error.code || 1,
        },
      };
    }
  },
};

// ============================================================================
// TOOL 5: ASK_USER
// ============================================================================

export const askUserTool: Tool = {
  name: "ask_user",
  description: "Ask the user for input or clarification",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional multiple choice options",
      },
      required: {
        type: "boolean",
        description: "Whether an answer is required",
        default: true,
      },
    },
    required: ["question"],
  },

  handler: async (
    params: {
      question: string;
      options?: string[];
      required?: boolean;
    },
    context: ToolExecutionContext,
  ): Promise<ToolResult> => {
    try {
      // This would integrate with your UI layer
      // For Node.js CLI, you might use readline
      const readline = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        if (params.options && params.options.length > 0) {
          console.log(`\n${params.question}`);
          params.options.forEach((opt, idx) => {
            console.log(`  ${idx + 1}. ${opt}`);
          });
          readline.question(
            "\nYour choice (number or text): ",
            (input: string) => {
              readline.close();

              // Try to parse as number
              const num = parseInt(input);
              if (!isNaN(num) && num > 0 && num <= params.options!.length) {
                resolve(params.options![num - 1] as any);
              } else {
                resolve(input);
              }
            },
          );
        } else {
          readline.question(`\n${params.question}\n> `, (input: string) => {
            readline.close();
            resolve(input);
          });
        }
      });

      // Validate if required
      if (params.required !== false && !answer.trim()) {
        return {
          success: false,
          error: "Answer is required but was empty",
        };
      }

      return {
        success: true,
        data: answer.trim(),
        metadata: {
          question: params.question,
          hadOptions: !!params.options,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to get user input: ${error.message}`,
      };
    }
  },
};

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

// ============================================================================
// EXPORT ALL TOOLS
// ============================================================================

export const CORE_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  executeCommandTool,
  askUserTool,
];
