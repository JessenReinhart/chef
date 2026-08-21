export interface HarnessReadinessItem {
  id: string;
  name: string;
  type: string;
  command: string | null;
  available: boolean;
  kind: "cli" | "generic";
}

export async function loadHarnessReadiness(): Promise<HarnessReadinessItem[]> {
  const response = await fetch("/api/harnesses/readiness", {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the HTTP status when the response is not JSON.
    }
    throw new Error(message);
  }

  const body = (await response.json()) as { ok: boolean; data: HarnessReadinessItem[] };
  return body.data;
}
