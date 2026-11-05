export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.MTP_DISABLE_RUNTIME !== "1") {
    const { startRuntime } = await import("./lib/runtime");
    startRuntime().catch((e) => console.error("[instrumentation] runtime failed to start", e));
  }
}
