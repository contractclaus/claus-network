import { authorize, copy, digest, integer, requireThat, text } from '../shared/index.mjs';
export function createPolicies({ store, schemas, authorize: check, now }) {
    const versionKey = (module, version) => digest({ module, version });
    async function version(module, name, reader = store) {
        requireThat(Object.hasOwn(schemas, module), 'unknown_policy_module');
        const record = (await reader.read('policy-versions', versionKey(module, name)));
        requireThat(record, 'policy_not_found');
        return record.value;
    }
    async function active(module, reader = store) {
        const pointer = (await reader.read('policy-active', text(module)));
        requireThat(pointer, 'policy_not_active');
        return { ...(await version(module, pointer.value.version, reader)), generation: pointer.revision };
    }
    return {
        active, version,
        async publish({ actor, module, version: name, config }) {
            text(module);
            text(name);
            (await authorize(check, actor, 'policy.publish', { module }));
            requireThat(Object.hasOwn(schemas, module), 'unknown_policy_module');
            const clean = copy(config);
            schemas[module](clean);
            const record = { module, version: name, config: clean, hash: digest({ module, version: name, config: clean }) };
            return store.transaction(async (tx) => {
                await authorize(check, actor, 'policy.publish', { module }, tx);
                const id = versionKey(module, name);
                const existing = (await tx.read('policy-versions', id));
                if (existing) {
                    requireThat(existing.value.hash === record.hash, 'immutable_policy_version');
                    return existing.value;
                }
                (await tx.write('policy-versions', id, record, 0));
                (await tx.event({ type: 'policy.published', module, version: name, hash: record.hash, actor: text(actor), at: now() }));
                return copy(record);
            });
        },
        async activate({ actor, module, version: name, expectedGeneration }) {
            integer(expectedGeneration);
            (await authorize(check, actor, 'policy.activate', { module }));
            return store.transaction(async (tx) => {
                await authorize(check, actor, 'policy.activate', { module }, tx);
                const target = (await version(module, name, tx));
                const old = (await tx.read('policy-active', module));
                requireThat((old?.revision ?? 0) === expectedGeneration, 'revision_conflict');
                if (old?.value.version === name)
                    return (await active(module, tx));
                const pointer = (await tx.write('policy-active', module, { version: name }, expectedGeneration));
                (await tx.event({
                    type: 'policy.activated', module, from: old?.value.version ?? null,
                    to: name, hash: target.hash, generation: pointer.revision, actor: text(actor), at: now()
                }));
                return { ...target, generation: pointer.revision };
            });
        }
    };
}
