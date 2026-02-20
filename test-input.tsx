import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useState, useCallback } from "react";

function App() {
  const [log, setLog] = useState("Type something and press Enter...");

  const handleSubmit = useCallback((value: string) => {
    setLog((prev) => prev + `\nSubmitted: "${value}"`);
  }, []);

  return (
    <box width="100%" height="100%" flexDirection="column">
      <text
        content={log}
        fg="#eeeeee"
        width="100%"
        flexGrow={1}
        wrapMode="word"
      />
      <box
        width="100%"
        height={3}
        border={true}
        borderStyle="rounded"
        borderColor="#666666"
        title=" > "
        titleAlignment="left"
      >
        <input
          width="100%"
          placeholder="Type here..."
          textColor="#ffffff"
          focusedTextColor="#fffddd"
          focused={true}
          onSubmit={handleSubmit as any}
        />
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useAlternateScreen: true,
});

createRoot(renderer).render(<App />);
renderer.start();
