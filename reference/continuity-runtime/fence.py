"""Policy decisions evaluated while holding the coordinator row lock."""
REQUIRED = frozenset(('native', 'lab', 'custody', 'payments', 'network', 'website'))
DATABASES = frozenset(('agent','signer','payments','network','portable','applications','website'))

def recovery_ready(records):
    # An old successful observation does not clear a newer source error.
    return {r['name'] for r in records if not r.get('last_error')
            and r.get('fresh') is True and r['body'].get('state')=='current'
            and r['body'].get('appliedCheckpoint')} == DATABASES

def transition_allowed(control, expected_epoch, pending, covered, target):
    if target not in ('primary','standby') or target == control['active_instance']:
        raise ValueError('invalid_transition_target')
    if target == 'primary':
        raise ValueError('reverse_synchronization_required')
    if control['epoch'] != expected_epoch or not control['expired'] or control['phase'] != 'draining':
        raise ValueError('old_lease_not_fenced')
    if pending:
        raise ValueError('original_effects_require_reconciliation')
    if frozenset(covered) != REQUIRED:
        raise ValueError('fence_coverage_incomplete')
    return control['epoch'] + 1
