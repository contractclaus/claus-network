import { canonical, digest, requireThat } from '../src/shared/index.mjs';
import { boundedResponse } from './imd.mjs';

// Fetch only a pinned public GitHub tree. No credentials, redirects, repository
// scripts or dependency installation are involved in this source comparison.
export async function verifyPublicSource({ input, files, fetch: fetcher = globalThis.fetch }) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/.exec(input.repoUrl);
  requireThat(match && /^[0-9a-f]{40}$/.test(input.baseCommit), 'unsupported_source_host');
  const runtime=input.reviewProfile==='claus-runtime-image-v1';
  requireThat(files.length > 0 && files.length <= (runtime?256:64), 'invalid_files');
  const deadline=runtime?AbortSignal.timeout(75000):null;
  if(runtime)requireThat(files.reduce((n,f)=>n+Buffer.byteLength(f.content??''),0)<=3000000,'invalid_files');
  const verified = [];
  for (let start = 0; start < files.length; start += 4) {
    const group = await Promise.all(files.slice(start, start + 4).map(async file => {
      requireThat((runtime?/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/:/^[A-Za-z0-9_/-]+\.(sol|json|md|txt)$/).test(file.path) && !file.path.startsWith('/') && !file.path.split('/').some(p=>p==='.'||p==='..'||p==='.git'), 'invalid_file_path');
      const url = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${input.baseCommit}/${file.path}`;
      const response = await fetcher(url, { redirect: 'error', signal: deadline?AbortSignal.any([deadline,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000) });
      requireThat(response.status === 200, 'source_unavailable');
      const content = await boundedResponse(response, runtime?3000000:input.reviewProfile==='claus-partner-launch-v1' && file.path===input.partnerLaunch?.requestFile ? 1000000 : 48000);
      const hash = digest({ path: file.path, content });
      requireThat(hash === file.hash, 'source_mismatch');
      return { path: file.path, hash };
    }));
    verified.push(...group);
  }
  requireThat(digest(verified) === input.sourceHash, 'source_mismatch');
  return { inputHash: digest(input), sourceHash: input.sourceHash, fileCount: files.length,
    repository: input.repoUrl, commit: input.baseCommit, bindingHash: digest(canonical(verified)) };
}
