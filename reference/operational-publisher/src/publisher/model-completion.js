function completionMetadata(response) {
  if (response?.telemetry?.["x-si-truncated"] === "1") return { status: "incomplete", finishReason: "length" };
  const status = ["completed", "incomplete"].includes(response?.responseStatus) ? response.responseStatus : "unknown";
  const raw = response?.choices?.[0]?.finish_reason;
  const finishReason = ["stop", "tool_calls", "length", "content_filter"].includes(raw) ? raw : "unknown";
  return { status, finishReason };
}
function completeModelOutput(output) {
  if (output && typeof output === "object" && !Object.hasOwn(output, "completion")) return true;
  const c = output?.completion;
  return c?.status === "completed" && ["stop", "tool_calls"].includes(c.finishReason);
}
export {
  completeModelOutput,
  completionMetadata
};
