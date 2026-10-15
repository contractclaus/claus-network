# Original publication recovery

R29 is a corrective follow-up to R28. It does not delegate any new source paths, credentials, financial authority or schedules.

The fixed publisher resolves a lost deployment or promotion response against the original reserved request and actual provider state. It never creates a replacement deployment during reconciliation. Activation binds both original request hashes and resulting deployment identities, checks the exact production deployment before and after verification, and commits only if the source and control authority still match. An unproven original request remains unknown. Historical attempts without a fixed-publisher journal stay historical, without invented receipts.

Within the activation transaction, the original release row is locked through the commit. JSON comparisons tolerate object-key ordering while preserving every value. Surface fallback rechecks the latest health failures under the same control lock and records the actual resulting control row, so a healthy observation cancels an obsolete fallback decision and an original retry remains idempotent.

Native handoff validates the current runner pin before advancing generation. Starting a reserved builder effect shares the runner-pin lock, in the same order as claim and reserve. Existing in-flight work still drains and is never reset for a release.

Six targeted publication/recovery cases and two Native cases cover these changed paths. This is not evidence of a new autonomous deployment, a production database restore, external acceptance or sustainable funding. All five handover packages remain incomplete; package six remains excluded.
