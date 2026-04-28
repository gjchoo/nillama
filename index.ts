// node-llama-cpp-prompt-session.ts
// A fully working prompt session for node-llama-cpp using Mistral mode.

import {
  defineChatSessionFunction,
  getLlama,
  LlamaChatSession,
} from "node-llama-cpp";
import * as readline from "readline";
import * as fs from "fs/promises";
import { ToolExecutor } from "./tools/tool-executor";
import {
  listDirectoryTool,
  readFileTool,
  getToolDefinitions,
} from "./tools/core-tools";

// Configuration for the Llama model in Mistral mode.
const MODEL_CONFIG = {
  modelPath: "./models/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf", // Replace with your model path.
};

// Read local file
const readFile = (path: string) => {
  return fs.readFile(path, "utf-8");
};

const buildSystemPrompt = (): string => {
  const toolDefs = getToolDefinitions();

  return `You are an autonomous coding agent. You think step-by-step and use tools to accomplish tasks.

        CRITICAL FORMAT - You MUST follow this exact structure:

        Thought: [Your reasoning about what to do next]
        Action: [JSON object with tool call]

        OR

        Thought: [Your final reasoning]
        Answer: [Your response to the user]

        AVAILABLE TOOLS:
        ${toolDefs}

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
let conversationHistory = [buildSystemPrompt()];

// Create a readline interface for interactive input.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
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

const functions = { readFileTool, listDirectoryTool };

// Function to load the model.
async function loadModel() {
  try {
    console.log("Loading model...");

    const llama = await getLlama({
      gpu: "cuda",
    });
    const model = await llama.loadModel(MODEL_CONFIG);

    const context = await model.createContext();
    session = new LlamaChatSession({
      systemPrompt: await readFile("./system/system_instruction.md"),
      contextSequence: context.getSequence(),
    });

    console.log("Model loaded successfully!");
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
      functions,
      temperature: 0.1,
      onTextChunk(chunk: string) {
        process.stdout.write(chunk);
      },
    });

    console.log("\nResponse:\n" + response);
  } catch (error) {
    console.error("Failed to generate text:", error);
  }
}

const parseResponse = (
  response: string,
): {
  thought: string | null;
  action: string | null;
  answer: string | null;
} => {
  const thoughtMatch = response.match(
    /Thought:\s*(.+?)(?=\n(?:Action|Answer):|$)/s,
  );
  const actionMatch = response.match(/Action:\s*(\{.+?\})/s);
  const answerMatch = response.match(/Answer:\s*(.+)$/s);

  return {
    thought: thoughtMatch ? thoughtMatch[1].trim() : null,
    action: actionMatch ? actionMatch[1].trim() : null,
    answer: answerMatch ? answerMatch[1].trim() : null,
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
      functions,
      temperature: 0.1,
      onTextChunk(chunk: string) {
        process.stdout.write(chunk);
      },
    });

    conversationHistory.push(`Assistant: ${response}`);

    console.log("\n[MODEL OUTPUT]:\n", response);

    // Parse response
    const { thought, action, answer } = parseResponse(response);

    if (answer) {
      console.log("\n[FINAL ANSWER]:", answer);
      return answer;
    }

    if (action) {
      console.log("\n[ACTION]:", action);
      //const observation = await this.toolExecutor.executeAction(action);
      //console.log("\n[OBSERVATION]:", observation);

      conversationHistory.push(`Observation: ${action}`);
    } else if (!thought) {
      // Model didn't follow format
      conversationHistory.push(
        "Observation: Error - You must output either Action: or Answer:. Try again following the format.",
      );
    }
  }
}

// Function to start the interactive prompt session.
function startPromptSession() {
  console.log("=== Node-Llama-CPP Mistral Prompt Session ===");
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
