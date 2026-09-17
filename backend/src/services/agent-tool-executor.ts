import { readFile, writeFile, listFiles, execCommand, getProjectTree } from './agent-tools';
import type { AgentPermission } from './agent-store';

export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

export interface ToolResult {
  name: string;
  args: Record<string, string>;
  output: string;
}

function toolDefinitionsForPermission(permission: AgentPermission | undefined): string {
  const tier = permission || 'full';
  const tools: string[] = [];

  // All tiers with tools get read + list
  if (tier === 'read' || tier === 'bash' || tier === 'full') {
    tools.push(`<tool name="readFile" path="path/to/file">Read file contents</tool>`);
    tools.push(`<tool name="listFiles" path="path/to/directory">List directory contents</tool>`);
    tools.push(`<tool name="getProjectTree" path="." maxDepth="3">Show project file tree</tool>`);
  }

  // bash + full get execCommand
  if (tier === 'bash' || tier === 'full') {
    tools.push(`<tool name="execCommand" command="shell command here">Execute a shell command</tool>`);
  }

  // Only full gets writeFile
  if (tier === 'full') {
    tools.push(`<tool name="writeFile" path="path/to/file" content="file content here">Write content to a file</tool>`);
  }

  if (tools.length === 0) return '';

  const header = `You have access to the following tools. Use them by writing XML tags in your response:

${tools.join('\n')}

Rules:
- Use ONE tool per response. Write your reasoning first, then the tool tag.
- After the tool executes, its result will be provided. Use it to continue your work.
- Do NOT write files outside the workspace. Paths are relative to the project root.
- Be careful with execCommand — avoid destructive commands.
- If a tool fails, explain why and try an alternative approach.
`;
  return header;
}

export function getToolDefinitions(permission?: AgentPermission): string {
  return toolDefinitionsForPermission(permission);
}

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = /<tool\s+name="([^"]+)"([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    const attrsStr = match[2];
    const args: Record<string, string> = {};

    const attrRegex = /(\w+)="([^"]*)"/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
      if (attrMatch[1] !== 'name') {
        args[attrMatch[1]] = attrMatch[2];
      }
    }

    calls.push({ name, args });
  }

  return calls;
}

function isToolAllowed(toolName: string, permission: AgentPermission | undefined): boolean {
  const tier = permission || 'full';
  switch (tier) {
    case 'none': return false;
    case 'read': return ['readFile', 'listFiles', 'getProjectTree'].includes(toolName);
    case 'bash': return ['readFile', 'listFiles', 'getProjectTree', 'execCommand'].includes(toolName);
    case 'full': return true;
    default: return true;
  }
}

export async function executeToolCall(slug: string, call: ToolCall, permission?: AgentPermission): Promise<ToolResult> {
  const { name, args } = call;

  if (!isToolAllowed(name, permission)) {
    return { name, args, output: `[Permission denied] Tool '${name}' is not allowed for this agent's permission level (${permission || 'full'})` };
  }

  try {
    let output: string;

    switch (name) {
      case 'readFile':
        output = readFile(slug, args.path || '');
        break;
      case 'writeFile':
        output = writeFile(slug, args.path || '', args.content || '');
        break;
      case 'listFiles':
        output = listFiles(slug, args.path || '.');
        break;
      case 'execCommand':
        // Async: executes inside the project container via docker exec.
        output = await execCommand(slug, args.command || 'echo "no command"');
        break;
      case 'getProjectTree':
        output = getProjectTree(slug, parseInt(args.maxDepth || '3', 10));
        break;
      default:
        output = `[Unknown tool: ${name}]`;
    }

    return { name, args, output };
  } catch (err: any) {
    return { name, args, output: `[Tool error: ${err.message || String(err)}]` };
  }
}

export function hasToolCalls(text: string): boolean {
  return /<tool\s+name="/.test(text);
}

export const MAX_TOOL_ITERATIONS = 10;
