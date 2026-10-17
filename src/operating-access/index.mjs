// Same existing identity as the participant-launch policy; this grants no signer rights.
const CLAUS_IDENTITY = '0x59edf6152080e847e5ea15f9ae6a77c1f03c44f5';

// Admission classification only. Every caller must still authorize the action,
// reserve its real cost and reconcile its original effects.
export async function operatingPrincipal(reader, principalId) {
  if (typeof principalId !== 'string') return false;
  const operation = (await reader.read('network-capabilities', 'continuous-operation'))?.value;
  if (operation?.enabled !== true || operation.profile !== 'claus-operation-v1' || operation.expiresAt !== null) return false;
  const principal = (await reader.read('principals', principalId))?.value;
  if (principal?.chainId !== 1 || typeof principal.address !== 'string') return false;
  const authority = (await reader.read('network', 'authority'))?.value;
  const address = principal.address.toLowerCase();
  return address === CLAUS_IDENTITY || address === authority?.ownerAddress?.toLowerCase();
}

export async function operatingProject(reader, projectId) {
  const project = (await reader.read('projects', projectId))?.value;
  return !!project && !project.archivedAt && !project.transfer && await operatingPrincipal(reader, project.ownerId);
}
