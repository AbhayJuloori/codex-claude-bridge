const baseUrl = process.env.BRIDGE_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.BRIDGE_TOKEN ?? "codex-bridge-local";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const createResponse = await fetch(`${baseUrl}/v1/messages/background`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      model: "bridge-test",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: "Compare two implementation approaches and summarize the tradeoffs."
        }
      ],
      metadata: {
        bridge_execution: "planner-worker"
      }
    })
  });

  const created = (await createResponse.json()) as {
    id: string;
    polling_url: string;
    events_url: string;
  };

  console.log("created:", created);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(1000);
    const statusResponse = await fetch(`${baseUrl}${created.polling_url}`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    const job = await statusResponse.json();
    console.log(JSON.stringify(job, null, 2));
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      break;
    }
  }

  const eventsResponse = await fetch(`${baseUrl}${created.events_url}`, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });
  console.log(await eventsResponse.text());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
