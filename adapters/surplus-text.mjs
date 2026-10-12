import { integer, requireThat } from '../src/shared/index.mjs';
import { validateInferenceProfile } from '../src/inference/index.mjs';

// Pure wire preparation only. It does not send requests, load credentials,
// authorize resale, establish a hard cost cap or verify settlement.
export function surplusTextRequest(profile, request) {
  const p = validateInferenceProfile(profile);
  requireThat(p.providerId === 'surplus' && request.model === p.model &&
    typeof request.input === 'string' && request.input.trim() &&
    Buffer.byteLength(request.input) <= p.maxInputBytes, 'unsupported_surplus_request');
  integer(request.maxOutputTokens, 1, p.maxOutputTokens);
  return { origin: 'https://api.surplusintelligence.ai', path: '/v1/chat/completions', method: 'POST',
    body: { model: p.model, provider: [...p.providers], stream: false,
      messages: [{ role: 'user', content: request.input }], max_tokens: request.maxOutputTokens } };
}

// Inline cost is a hint, never a final charge receipt. Response IDs in an
// OpenAI-shaped body are not assumed to be Surplus request-log IDs.
export function surplusTextObservation(profile, body, headers = {}) {
  const p = validateInferenceProfile(profile), choice = body?.choices?.[0];
  const get = name => typeof headers.get === 'function' ? headers.get(name) : headers[name];
  const inline = get('x-si-buyer-cost-micro') ?? body?.usage?.buyer_cost_micro;
  const provisionalCost = typeof inline === 'number' && Number.isSafeInteger(inline) && inline >= 0 ? String(inline) :
    typeof inline === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(inline) ? inline : null;
  const complete = body?.model === p.model && get('x-si-truncated') !== '1' &&
    choice?.finish_reason === 'stop' && typeof choice.message?.content === 'string' &&
    Buffer.byteLength(choice.message.content) <= 262144 && !choice.message.tool_calls?.length;
  return { work: complete ? 'completed' : 'unknown',
    output: complete ? { model: p.model, text: choice.message.content } : null,
    provisionalCost, receipt: null, providerRequestId: null };
}
