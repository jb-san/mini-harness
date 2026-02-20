import { createUI } from "./ui";
import { createSession } from "./core";

const { callbacks, waitForInput } = await createUI();
const session = createSession();

while (true) {
  const input = await waitForInput();
  if (!input) continue;
  await session.run(input, callbacks);
}
