export function requestUrl(value, origin) {
  const url = new URL(value, origin);
  const routed = url.searchParams.get('__claus_route');
  // The public path is authoritative when the host preserves it. A direct
  // function invocation may use the explicit rewrite destination instead.
  if (url.pathname === '/api/gateway' && (routed === '/internal/infrastructure/volume-funding' || routed?.startsWith('/v1/') || routed === '/v2' || routed?.startsWith('/v2/'))) url.pathname = routed;
  url.searchParams.delete('__claus_route');
  const capture = url.searchParams.get('path');
  const tail = url.pathname.slice(4);
  if (url.pathname.startsWith('/v1/') && capture !== null &&
    [tail, '/' + tail, decodeURIComponent(tail), '/' + decodeURIComponent(tail)].includes(capture)) url.searchParams.delete('path');
  return url;
}
