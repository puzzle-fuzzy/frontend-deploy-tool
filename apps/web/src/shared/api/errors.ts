export function extractMessage(text: string): string {
  try {
    return JSON.parse(text)?.error?.message ?? text;
  } catch {
    return text;
  }
}

export async function checkOk(res: {
  ok: boolean;
  statusText: string;
  text: () => Promise<string>;
}): Promise<void> {
  if (res.ok) return;
  const text = await res.text();
  throw new Error(extractMessage(text) || res.statusText);
}
