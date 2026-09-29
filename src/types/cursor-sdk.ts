export type ToolName =
  | "delete"
  | "webFetch"
  | "webSearch"
  | "read"
  | "grep"
  | "glob"
  | "ls"
  | "semSearch";

export class CursorAgentError extends Error {}

type ModelRow = { id: string };

export const Cursor: {
  models: { list(opts: { apiKey: string }): Promise<ModelRow[]> };
} = {
  models: {
    list: () => Promise.resolve([]),
  },
};

type RunEvent = { type: string; name: string; status: string };

type Run = {
  stream(): AsyncIterable<RunEvent>;
  wait(): Promise<{ status: string; error?: { message?: string }; result?: string }>;
};

type AgentHandle = {
  send(text: string): Promise<Run>;
  close(): void;
};

export const Agent: {
  create(opts: {
    apiKey: string;
    model: { id: string };
    local: { cwd: string };
    tools?: ToolName[];
    disallowedTools?: ToolName[];
  }): Promise<AgentHandle>;
} = {
  create: () => Promise.reject(new Error("Cursor SDK is not loaded.")),
};
