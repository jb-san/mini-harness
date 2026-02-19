const LLM_BASE_URL = "http://localhost:1234/v1";

const routes = {
  models: `${LLM_BASE_URL}/models`,
  responses: `${LLM_BASE_URL}/responses`,
  completions: `${LLM_BASE_URL}/completions`,
};

async function fetchResponse(prompt: string) {
  const response = await fetch(routes.responses, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: prompt,
      model: "zai-org/glm-4.7-flash",
      stream: true,
    }),
  });

  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "response.reasoning_text.delta") {
        process.stdout.write(event.delta);
      } else if (event.type === "response.reasoning_text.done") {
        process.stdout.write("\n\n---\n\n");
      } else if (event.type === "response.output_text.delta") {
        process.stdout.write(event.delta);
      }
    }
  }
  console.log();
}

await fetchResponse("hello");

export {};
