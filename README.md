# Mini-Harness

A local LLM harness that enables AI agents to interact with the filesystem and shell through tool calling. This project experiments with creating a framework for building autonomous AI agents that can perform tasks by calling tools.

## What it does

This harness connects to a local LLM (default: Ollama running `glm-4.7-flash`) and enables the AI to:

- **Read files** - Read contents of any file on the system
- **Write files** - Create or overwrite files with specified content
- **List directories** - List files and directories in a given path
- **Run shell commands** - Execute shell commands and capture output

The system uses a loop that:
1. Sends messages to the LLM with available tools
2. Parses tool calls from the LLM response
3. Executes the tools and returns results
4. Feeds results back to the LLM for the next iteration
5. Continues until the LLM produces a final response without tool calls

## Prerequisites

- **Node.js** (or Bun) installed
- **Ollama** running locally with the `glm-4.7-flash` model
  - Install Ollama: https://ollama.ai
  - Pull the model: `ollama pull glm-4.7-flash`

## Installation

```bash
bun install
```

## Running

```bash
bun start
```

Or with npm:
```bash
npm install
npm start
```

## Usage

1. Start the harness: `bun start`
2. Type your message and press Enter
3. The AI will respond, potentially calling tools to help you
4. Type `ctrl+c` to quit

## Examples

### Read a file
```
> Read package.json and tell me what dependencies are listed
```

### List directory contents
```
> List all files in the current directory
```

### Run a shell command
```
> Run `ls -la` and show me the output
```

### Create a file
```
> Create a file called hello.txt with the content "Hello, World!"
```

## Concepts I want to learn

- [x] handle raw interactions with local llms
- [x] tool calling
- [ ] memory management
- [ ] context management
- [x] task system
- [ ] agent orchistration
- [ ] security restrictions
