// react-agent.ts
import { LlamaModel, LlamaContext, LlamaChatSession } from "node-llama-cpp";
import { ToolExecutor } from "./tool-executor";

export class ReactAgent {
  private model: LlamaModel;
  private context: LlamaContext;
  private session: LlamaChatSession;
  private toolExecutor: ToolExecutor;
  private conversationHistory: string[];

  constructor(modelPath: string, workingDirectory?: string) {
    this.model = new LlamaModel({ modelPath });
    this.context = new LlamaContext({ model: this.model });
    this.session = new LlamaChatSession({ context: this.context });

    this.toolExecutor = new ToolExecutor({
      workingDirectory: workingDirectory || process.cwd(),
      allowedPaths: [workingDirectory || process.cwd()],
      maxFileSize: 10 * 1024 * 1024,
      commandTimeout: 30000,
    });

    this.conversationHistory = [];
  }

  async run(userQuery: string, maxIterations: number = 15): Promise<string> {
    const systemPrompt = this.buildSystemPrompt();
    this.conversationHistory = [systemPrompt, `User: ${userQuery}`];

    for (let i = 0; i < maxIterations; i++) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Iteration ${i + 1}/${maxIterations}`);
      console.log("=".repeat(60));

      // Get model response
      const fullPrompt = this.conversationHistory.join("\n\n");
      const response = await this.session.prompt(fullPrompt, {
        maxTokens: 512,
        temperature: 0.2,
        stopStrings: ["Observation:", "User:"],
      });

      this.conversationHistory.push(`Assistant: ${response}`);
      console.log("\n[MODEL OUTPUT]:\n", response);

      // Parse response
      const { thought, action, answer } = this.parseResponse(response);

      if (answer) {
        console.log("\n[FINAL ANSWER]:", answer);
        return answer;
      }

      if (action) {
        console.log("\n[ACTION]:", action);
        const observation = await this.toolExecutor.executeAction(action);
        console.log("\n[OBSERVATION]:", observation);

        this.conversationHistory.push(`Observation: ${observation}`);
      } else if (!thought) {
        // Model didn't follow format
        this.conversationHistory.push(
          "Observation: Error - You must output either Action: or Answer:. Try again following the format.",
        );
      }
    }

    throw new Error("Max iterations reached without completing task");
  }

  private buildSystemPrompt(): string {
    const toolDefs = this.toolExecutor.getToolDefinitions();

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
  }

  private parseResponse(response: string): {
    thought: string | null;
    action: string | null;
    answer: string | null;
  } {
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
  }
}

// Usage
async function main() {
  const agent = new ReactAgent(
    "./models/Ministral-3-14B-Reasoning-2512-Q5_K_M.gguf",
    process.cwd(),
  );

  const result = await agent.run(
    "List all TypeScript files in the current directory and tell me how many there are",
  );

  console.log("\n\nFINAL RESULT:", result);
}

main().catch(console.error);
