export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const onRequestError: (...args: any[]) => Promise<void> = async (
  err,
  request,
  context
) => {
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(err, request, context);
};
