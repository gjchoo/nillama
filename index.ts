// node-llama-cpp-prompt-session.ts
// A fully working prompt session for node-llama-cpp using Mistral mode.
import * as readline from "readline";
import * as fs from "fs/promises";
import ora from "ora";
import {
    getLlama,
    LlamaChatSession,
    defineChatSessionFunction,
    LlamaContext
} from "node-llama-cpp";

import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {SSEClientTransport} from "@modelcontextprotocol/sdk/client/sse.js";
import {ToolExecutor} from "./tools/tool-executor";

import {
    listDirectoryTool,
    readFileTool,
    getToolDefinitions,
    getAWSToolDefinitions
} from "./tools/core-tools";
import type {LLMResponseType} from "./types/types";


let client: Client | undefined = undefined;
const baseUrl = new URL("https://knowledge-mcp.global.api.aws");
client = new Client({
    name: "streamable-http-client",
    version: "1.0.0"
});
try {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    console.log("Connected using Streamable HTTP transport");
} catch (error) {
    // If that fails, fall back to SSE
    console.log(
        "Streamable HTTP connection failed, falling back to SSE transport"
    );
}

// Now your agent can list and call tools from the remote server
const toolList = await client.listTools();

// Configuration for the Llama model in Mistral mode.
const MODEL_CONFIG = {
    modelPath: "./models/Ministral-3-14B-Instruct-2512-Q5_K_M.gguf" // Replace with your model path.
};

// Initiate Tools
const tools = new ToolExecutor();

const buildSystemPrompt = (): string => {
    const toolDefs = getToolDefinitions();
    const awsTools = new Map(toolList.tools.map((tool) => [tool.name, tool]));
    const awsToolDefinition = getAWSToolDefinitions(awsTools);
    console.log(awsToolDefinition);
    return `You are an autonomous coding agent. You think step-by-step and use tools to accomplish tasks.

        CRITICAL FORMAT - You MUST follow this exact structure:

        Thought: [Your reasoning about what to do next]
        Action: [JSON object with tool call]

        OR

        Thought: [Your final reasoning]
        Answer: [Your response to the user]

        AVAILABLE TOOLS:
        ${tools.getToolDefinitions()}

        ACTION FORMAT TO FOLLOW VALID JSON:
        Action: 
        { 
            "tool_name": "toolName", 
            params: { 
                    "param1": "value1", 
                    "param2": "value2"
                }
        }

        AVAILABLE AWS TOOLS:
        ${awsToolDefinition}

        ACTION FORMAT:
        Action: {"tool_name": {"param1": "value1", "param2": "value2"}}

        EXAMPLES:

        User: Read the package.json file
        Thought: I need to read the package.json to see the project dependencies
        Action: {"read_file": {"path": "package.json"}}

        Observation: { "name": "my-project", "version": "1.0.0", ... }
        Thought: I can now answer the user's question
        Answer: The package.json shows this is "my-project" version 1.0.0 with dependencies...

        RULES:
        1. Always output Thought: before Action: or Answer:
        2. Only use tools that are listed above
        3. Action must be valid JSON
        4. After Observation, continue with next Thought
        5. Use Answer: only when you have the final response
        6. Never output both Action and Answer in same turn
    `;
};

// Initialize the Llama model.
let session: LlamaChatSession;
let context: LlamaContext;
const conversationHistory: string[] = [];

// Create a readline interface for interactive input.
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// const functions = {
//   writeOutputFile: defineChatSessionFunction({
//     description: "Save generated content to a file",
//     params: {
//       type: "object",
//       properties: {
//         name: { type: "string", description: "Filename" },
//         outputPath: { type: "string", description: "path to save file" },
//         content: {
//           type: "string",
//           description: "The complete file content to save",
//         },
//       },
//       required: ["name", "outputPath", "content"],
//     },
//     async handler(params) {
//       const { name, outputPath, content } = params;
//       console.log(params);
//       // await fs.mkdir(path.dirname(outputPath), { recursive: true });
//       await fs.writeFile(outputPath, content, "utf-8");
//       //
//       return {
//         success: true,
//         path: outputPath,
//         contentLength: content.length,
//         message: `File '${name}' created successfully`,
//       };
//     },
//   }),
//   readDirectory: defineChatSessionFunction({
//     description: "Read and list all files and directories in a given path",
//     params: {
//       type: "object",
//       properties: {
//         directoryPath: {
//           type: "string",
//           description:
//             "The directory path to read (e.g., './', './src', '/home/user/documents')",
//         },
//       },
//       required: ["directoryPath"],
//     },
//     async handler(params) {
//       const { directoryPath } = params;

//       try {
//         console.log(`Reading directory: ${directoryPath}`);
//         const files = await fs.readFile(directoryPath);

//         return {
//           success: true,
//           path: directoryPath,
//           files: files,
//           fileCount: files.length,
//           message: `Found ${files.length} items in directory`,
//         };
//       } catch (error: any) {
//         return {
//           success: false,
//           error: error.message,
//         };
//       }
//     },
//   }),
// };

// const functions = { readFileTool, listDirectoryTool };

// Function to load the model.
async function loadModel() {
    try {
        const spinner = ora("Loading model...").start();

        const llama = await getLlama({
            gpu: "cuda"
        });
        
        const model = await llama.loadModel(MODEL_CONFIG);

        context = await model.createContext();
        session = new LlamaChatSession({
            systemPrompt: buildSystemPrompt(),
            contextSequence: context.getSequence()
        });

        session = new LlamaChatSession({
            systemPrompt: buildSystemPrompt(),
            contextSequence: context.getSequence()
        });

        spinner.succeed("🧠 Model loaded");
    } catch (error) {
        console.error("Failed to load model:", error);
        process.exit(1);
    }
}

// Function to generate text using the model.
async function generateText(prompt: string) {
    if (!session) {
        console.error("Model not loaded. Call loadModel() first.");
        return;
    }

    try {
        console.log("\nGenerating response...");
        const response = await session.prompt(prompt, {
            // functions,
            temperature: 0.1,
            onTextChunk(chunk: string) {
                process.stdout.write(chunk);
            }
        });

        console.log("\nResponse:\n" + response);
    } catch (error) {
        console.error("Failed to generate text:", error);
    }
}

const parseResponse = (response: string): LLMResponseType => {
    // Thought: capture until Action or Answer
    const thoughtMatch = response.match(
        /Thought:\s*([\s\S]*?)(?=\n\s*(?:Action|Answer):|$)/i
    );

    // Action: prefer fenced JSON block first
    const actionBlockMatch = response.match(
        /Action:\s*```(?:json)?\s*([\s\S]*?)```/i
    );

    // Fallback: inline JSON after Action:
    const actionInlineMatch = response.match(
        /Action:\s*(\{[\s\S]*\})/i
    );

    const action = actionBlockMatch
        ? actionBlockMatch[1].trim()
        : actionInlineMatch
            ? actionInlineMatch[1].trim()
            : null;

    const answerMatch = response.match(
        /Answer:\s*([\s\S]*)/i
    );

    return {
        thought: thoughtMatch ? thoughtMatch[1].trim() : null,
        action,
        answer: answerMatch ? answerMatch[1].trim() : null
    };
};

// ============================================================================
// ReACT Agent
// ============================================================================
async function run(userQuery: string, maxIterations: number = 15) {
    if (!session) {
        console.error("Model not loaded. Call loadModel() first.");
        return;
    }

    conversationHistory.push(`User: ${userQuery}`);

    for (let i = 0; i < maxIterations; i++) {
        console.log(`\n${"=".repeat(60)}`);
        console.log(`Iteration ${i + 1}/${maxIterations}`);
        console.log("=".repeat(60));

        // Get model response
        const fullPrompt = conversationHistory.join("\n\n");
        const response = await session.prompt(fullPrompt, {
            // functions,
            temperature: 0.1,
            maxTokens: context.contextSize,
            onTextChunk(chunk: string) {
                process.stdout.write(chunk);
            }
        });

        conversationHistory.push(`Assistant: ${response}`);

        // Parse response
        const {thought, action, answer} = parseResponse(response);

        if (answer) {
            console.log("\n[FINAL ANSWER]:", answer);
            return answer;
        }

        conversationHistory.push(`User: ${userQuery}`);

        for (let i = 0; i < maxIterations; i++) {
            console.log(`\n${"=".repeat(60)}`);
            console.log(`Iteration ${i + 1}/${maxIterations}`);
            console.log("=".repeat(60));

            // 🌀 Spinner starts here
            const spinner = ora(`Thinking (iteration ${i + 1})...`).start();
            let response: string;
            let hasStartedStreaming = false;

            try {
            // Get model response
                const fullPrompt = conversationHistory.join("\n\n");
                response = await session.prompt(fullPrompt, {
                // functions,
                    temperature: 0.3,
                    onTextChunk(chunk: string) {
                    // 🛑 Stop spinner EXACTLY when first token arrives
                        if (!hasStartedStreaming) {
                            spinner.stop(); // don't use succeed(), just stop cleanly
                            process.stdout.write("\n"); // move to next line
                            hasStartedStreaming = true;
                        }

                        process.stdout.write(chunk);
                    }
                });
            } catch (error) {
                spinner.fail("Model failed");
                throw error;
            }

            // If model returned instantly (no streaming triggered)
            if (!hasStartedStreaming) {
                spinner.succeed("Response ready");
            } else {
                process.stdout.write("\n"); // clean newline after stream
            }

            // Get model response
            spinner.succeed("Model responded");
            conversationHistory.push(`Assistant: ${response}`);

            // Parse response
            const {thought, action, answer} = parseResponse(response);

  
            if (answer) {
                console.log("\n✅ FINAL ANSWER:\n", answer);
                return answer;
            }

            if (thought) {
                console.log("\n🧠 Thought:\n", thought);
            }

            if (action) {
            // 🔧 Tool execution spinner
                console.log("\n🛠 ACTION:\n", action);
                const toolSpinner = ora("Executing tool...").start();
 
                const observation = await tools.executeAction(action);
    
                toolSpinner.succeed("Tool executed");

                console.log("\n📦 OBSERVATION:\n", observation);

                conversationHistory.push(`Observation: ${observation}`);
            } else if (!thought) {
                spinner.warn("Invalid format");
                // Model didn't follow format
                conversationHistory.push(
                    "Observation: Error - You must output either Action: or Answer:. Try again following the format."
                );
            }
        }
    }
}

// Function to start the interactive prompt session.
function startPromptSession() {
    console.log("=== TS Nillama Prompt Session ===");
    console.log("Type your prompt and press Enter. Type 'exit' to quit.");

    rl.on("line", async (line) => {
        if (line.toLowerCase().trim() === "exit") {
            console.log("Exiting...");
            rl.close();
            process.exit(0);
        }

        await run(line);
    });
}

// Main function to initialize the session.
async function main() {
    await loadModel();
    startPromptSession();
}

// Start the application.
main().catch(console.error);
