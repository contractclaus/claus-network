// A display association is not a membership, mandate or runtime transfer.
// Bind both owners so a later project transfer cannot carry the association.
export async function agentPublicationVisible(reader, publication) {
  if (!publication?.published) return false;
  const binding = publication.ownerBinding;
  if (!binding) return true;
  const [source, destination, access, agent] = await Promise.all([
    reader.read('projects', binding.sourceProjectId),
    reader.read('projects', publication.projectId),
    reader.read('project-access', binding.sourceProjectId),
    reader.read('principals', publication.agentId)
  ]);
  return !!(source?.value && destination?.value && agent?.value.kind === 'agent' &&
    agent.value.projectId === binding.sourceProjectId &&
    source.value.ownerId === binding.ownerId && destination.value.ownerId === binding.ownerId &&
    !source.value.archivedAt && !source.value.transfer &&
    !destination.value.archivedAt && !destination.value.transfer && !access?.value.suspended);
}
