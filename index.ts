import { createUI } from "./ui";
import { run } from "./core";

const { callbacks, waitForInput } = await createUI();

while (true) {
  const input = await waitForInput();
  if (!input) continue;
  await run(input, callbacks);
}
