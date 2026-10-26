// ── Server status ────────────────────────────────────────────────────────────

const status_element = document.querySelector<HTMLSpanElement>("#server_status");

async function show_server_status(): Promise<void> {
  if (!status_element) return;
  try {
    const response = await fetch("/api/health");
    const body: { status: string } = await response.json();
    status_element.textContent = body.status;
  } catch {
    status_element.textContent = "unreachable";
  }
}

void show_server_status();
