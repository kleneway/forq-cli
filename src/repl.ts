import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Using require for chalk to avoid ESM issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chalk = require('chalk');

import { Message } from './types/messages';
import { loadSystemPrompt } from './config/systemPrompt';
import { queryAI, streamAI } from './api/ai';
import { logger } from './utils/logger';
import { loadTools, extractToolCalls, executeTool, getAllTools, getToolsSchema } from './tools';
import { ToolContext } from './types/tools';

/**
 * Interactive REPL (Read-Eval-Print Loop) for the forq CLI
 * Handles user input and interacts with AI
 */
export async function startRepl(): Promise<void> {
  // Load available tools
  await loadTools();
  console.log(
    chalk.cyan('Loaded tools: ') +
      getAllTools()
        .map((t) => t.name)
        .join(', '),
  );

  // Create history file directory if it doesn't exist
  const historyDir = path.join(os.homedir(), '.forq');
  const historyFile = path.join(historyDir, 'history');

  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }

  // Read history file if it exists
  let history: string[] = [];
  if (fs.existsSync(historyFile)) {
    history = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
  }

  let historyIndex = history.length;
  let currentInput = '';

  // Create tool context
  const toolContext: ToolContext = {
    cwd: process.cwd(),
    logger: logger,
  };

  // Get system prompt and append information about available tools
  const systemPrompt = loadSystemPrompt();

  // Get tool schema for AI
  const toolsInfo = getToolsSchema();

  // Add tools information to system prompt
  const enhancedSystemPrompt: Message = {
    ...systemPrompt,
    content: `${systemPrompt.content}\n\nYou have access to the following tools:\n${getAllTools()
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join(
        '\n',
      )}\n\nTo use a tool, respond with the syntax: <tool:toolName>{"param1": "value1", "param2": "value2"}</tool>`,
  };

  // Initialize conversation with enhanced system prompt
  const conversation: Message[] = [enhancedSystemPrompt];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue('forq> '),
    historySize: 100,
    completer: (line: string) => {
      const completions = ['/help', '/clear', '/exit', '/reset', '/tools'];
      const hits = completions.filter((c) => c.startsWith(line));
      return [hits.length ? hits : completions, line];
    },
  });

  // Enable keypress events
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // We need to use readline.emitKeypressEvents to handle arrow keys
  readline.emitKeypressEvents(process.stdin);

  console.log(
    chalk.green('Welcome to forq CLI!'),
    chalk.yellow('Type /help for available commands.'),
  );
  rl.prompt();

  // Handle history navigation and input processing
  process.stdin.on('keypress', (_, key) => {
    if (!key) return;

    if (key.name === 'up' && historyIndex > 0) {
      if (historyIndex === history.length) {
        currentInput = rl.line;
      }
      historyIndex--;
      // Clear current line
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);

      // Write the prompt and historical command
      process.stdout.write(chalk.blue('forq> ') + history[historyIndex]);
    } else if (key.name === 'down') {
      // Clear current line
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);

      if (historyIndex < history.length - 1) {
        historyIndex++;
        // Write the prompt and historical command
        process.stdout.write(chalk.blue('forq> ') + history[historyIndex]);
      } else if (historyIndex === history.length - 1) {
        historyIndex = history.length;
        // Write the prompt and current input
        process.stdout.write(chalk.blue('forq> ') + currentInput);
      } else {
        // Just rewrite the prompt
        process.stdout.write(chalk.blue('forq> '));
      }
    }
  });

  rl.on('line', async (line) => {
    const trimmedLine = line.trim();

    // Don't add empty lines or duplicates to history
    if (trimmedLine && (history.length === 0 || history[history.length - 1] !== trimmedLine)) {
      history.push(trimmedLine);
      fs.writeFileSync(historyFile, history.join('\n') + '\n');
      historyIndex = history.length;
    }

    // Handle basic REPL commands
    if (trimmedLine === '/help') {
      console.log(chalk.yellow('Available commands:'));
      console.log(chalk.cyan('/help') + ' - Display this help message');
      console.log(chalk.cyan('/clear') + ' - Clear the console');
      console.log(chalk.cyan('/exit') + ' - Exit the REPL');
      console.log(chalk.cyan('/reset') + ' - Reset the conversation');
      console.log(chalk.cyan('/tools') + ' - List available tools');
    } else if (trimmedLine === '/clear') {
      console.clear();
    } else if (trimmedLine === '/exit') {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      rl.close();
      return;
    } else if (trimmedLine === '/reset') {
      conversation.length = 1; // Keep only the system prompt
      console.log(chalk.yellow('Conversation reset.'));
    } else if (trimmedLine === '/tools') {
      console.log(chalk.yellow('Available tools:'));
      getAllTools().forEach((tool) => {
        console.log(chalk.cyan(tool.name) + ' - ' + tool.description);
      });
    } else if (trimmedLine) {
      // Create user message
      const userMessage: Message = {
        role: 'user',
        content: trimmedLine,
      };

      // Add user message to conversation
      conversation.push(userMessage);

      // Log user message
      logger.logConversation(`User: ${trimmedLine}`);

      // Show thinking indicator
      process.stdout.write(chalk.gray('Thinking... '));

      try {
        // Get AI response
        const aiResponse = await queryAI(conversation);

        // Clear the thinking indicator
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);

        // Extract tool calls from AI response
        const toolCalls = extractToolCalls(aiResponse);

        // Process tool calls if any
        if (toolCalls.length > 0) {
          console.log(chalk.green('AI: ') + aiResponse);

          // Execute each tool call
          for (const toolCall of toolCalls) {
            console.log(chalk.cyan(`Executing tool: ${toolCall.name}`));

            try {
              const result = await executeTool(toolCall, toolContext);

              if (result.success) {
                console.log(chalk.green('Tool execution successful:'));
                console.log(JSON.stringify(result.result, null, 2));
              } else {
                console.log(chalk.red('Tool execution failed:'));
                console.log(result.error);
              }
            } catch (error) {
              console.error(chalk.red('Error executing tool: ') + (error as Error).message);
            }
          }
        } else {
          // Just display the normal response
          console.log(chalk.green('AI: ') + aiResponse);
        }

        // Add AI response to conversation
        conversation.push({
          role: 'assistant',
          content: aiResponse,
        });
      } catch (error) {
        // Clear the thinking indicator
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);

        console.error(chalk.red('Error: ') + (error as Error).message);
        logger.logError(error as Error, 'REPL Error');
      }
    }

    rl.prompt();
  }).on('close', () => {
    console.log(chalk.yellow('Goodbye!'));
    process.exit(0);
  });
}
