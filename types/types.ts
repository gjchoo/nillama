// types.ts
export interface ToolResult {
    success: boolean,
    data?: any,
    error?: string,
    metadata?: Record<string, any>
}

export interface ToolExecutionContext {
    workingDirectory: string,
    maxFileSize: number, // bytes
    allowedPaths: string[], // whitelist for security
    commandTimeout: number // milliseconds
}

export interface Tool {
    description: string,
    params: Record<string, any>,
    handler: (params: any, context: ToolExecutionContext) => Promise<ToolResult>
}

// Helper for recursive listing
export interface DirectoryItem {
    name: string,
    path: string,
    type: "file" | "directory" | "symlink" | "other",
    size?: number,
    modified?: Date
}

export interface LLMResponseType {
    thought: string | null,
    action: string | null,
    answer: string | null
}
