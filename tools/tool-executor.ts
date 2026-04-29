// tool-executor.ts
import {CORE_TOOLS} from "./core-tools";
import type {Tool, ToolExecutionContext, ToolResult} from "../types/types";

export class ToolExecutor {
    private tools: Map<string, Tool>;
    private context: ToolExecutionContext;

    constructor(context: Partial<ToolExecutionContext> = {}) {
        this.tools = new Map(CORE_TOOLS.map((tool) => [tool.description, tool]));

        this.context = {
            workingDirectory: context.workingDirectory || process.cwd(),
            maxFileSize: context.maxFileSize || 10 * 1024 * 1024, // 10MB
            allowedPaths: context.allowedPaths || [process.cwd()],
            commandTimeout: context.commandTimeout || 30000 // 30s
        };
    }

    /**
     * Get tool definitions for LLM prompt
     */
    public getToolDefinitions(): string {
        return Array.from(this.tools.values())
            .map((tool) => {
                return `tool_name: ${tool.description}, params: ${JSON.stringify(tool.params, null, 2)}`;
            })
            .join("\n\n");
    }

    /**
     * Execute a tool by name with parameters
     */
    private async executeTool(toolName: string, parameters: any): Promise<ToolResult> {
        const tool = this.tools.get(toolName);

        if (!tool) {
            return {
                success: false,
                error: `Unknown tool: ${toolName}. Available tools: ${Array.from(this.tools.keys()).join(", ")}`
            };
        }

        // Validate parameters against schema (basic validation)
        const validationError = this.validateParameters(
            parameters,
            tool.params
        );

        if (validationError) {
            return {
                success: false,
                error: `Invalid parameters: ${validationError}`
            };
        }

        try {
            console.log(`[TOOL] \n Tool Name: ${toolName} \nParams:`, parameters);
            const result = await tool.handler(parameters, this.context);
        
            console.log(
                `[TOOL] ${toolName} completed:`,
                result.success ? "SUCCESS" : "FAILED"
            );

            return result;
        } catch (error: any) {
            return {
                success: false,
                error: `Tool execution failed: ${error.message}`
            };
        }
    }

    /**
     * Parse action string from LLM and execute
     */
    public async executeAction(actionString: string): Promise<string> {
        try {
            // Try to parse as JSON
            const parsed = JSON.parse(actionString);

            // Support both formats:
            // {"tool_name": {"param": "value"}}
            // {"name": "tool_name", "parameters": {...}}

            let toolName: string;
            let parameters: any;

            if (parsed.tool_name && parsed.params) {
                toolName = parsed.tool_name;
                parameters = parsed.params;
            } else {
                throw new Error("Invalid action payload schema");
            }

            console.log("Execute Action: " + "Tool:" + toolName + " Params: " + JSON.stringify(parameters));

            const result = await this.executeTool(toolName, parameters);
            
            if (result.success) {
                return this.formatSuccessResult(result);
            } else {
                return `Error: ${result.error}`;
            }
        } catch (error: any) {
            return `
                Failed to parse action: 
                ${error.message}

                \n Expected JSON format: 
                { 
                    "tool_name": "toolName", 
                    params: { 
                            "param1": "value1", 
                            "param2": "value2"
                        }
                }

                \n Current JSON format
                ${actionString}
            `;
        }
    }

    private validateParameters(params: any, schema: any): string | null {
        if (schema.required) {
            for (const requiredParam of schema.required) {
                if (!(requiredParam in params)) {
                    return `Missing required parameter: ${requiredParam}`;
                }
            }
        }
        return null;
    }

    private formatSuccessResult(result: ToolResult): string {
        if (typeof result.data === "string") {
            return result.data;
        }

        if (result.data && typeof result.data === "object") {
            // Format based on what the data looks like
            if (Array.isArray(result.data)) {
                return `Found ${result.data.length} items:\n${JSON.stringify(result.data, null, 2)}`;
            }

            if (result.data.stdout !== undefined) {
                // Command output
                let output = "";
                if (result.data.stdout) output += result.data.stdout;
                if (result.data.stderr) output += `\nSTDERR: ${result.data.stderr}`;
                return output || "(command produced no output)";
            }

            return JSON.stringify(result.data, null, 2);
        }

        return "Operation completed successfully";
    }

    /**
     * Update execution context (e.g., change working directory)
     */
    public updateContext(updates: Partial<ToolExecutionContext>) {
        this.context = {...this.context, ...updates};
    }

    /**
     * Add custom tool at runtime
     */
    public registerTool(tool: Tool) {
        this.tools.set(tool.name, tool);
    }
}
