const baseUrl = process.env.BRIDGE_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.BRIDGE_TOKEN ?? "codex-bridge-local";

async function main(): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      model: "bridge-test",
      max_tokens: 256,
      stream: false,
      messages: [
        {
          role: "user",
          content: "Reply with exactly PROXY_BRIDGE_OK"
        }
      ]
    })
  });

  const text = await response.text();
  console.log(`HTTP ${response.status}`);
  console.log(text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
