# HO196: rebuild from the approved declared image

The native Linux recovery stopped at materialization after image and resource
checks passed. Protected inspection found an owned, stopped VM with intact
storage from Ubuntu production v6, while declaration revision 2 required v14.
The observation owner correctly diagnosed storage invalid against that
declaration, but materialization rejected the source change and the persistent
rebuild owner could only use the old source.

The fix carries the declared image through the existing rebuild contract. The
durable replacement pins its target source and previous source, checks old
ownership and lineage, and retains the superseded VM/disk. Target source drift
cannot retarget an interrupted operation. Generic startup reconciliation still
waits for the outer lifecycle fence. Provider adapters and disk lineage mechanics
are unchanged.

The regression composes the real materialization and persistent-environment
owners with a fake provider. An intact old-image VM is diagnosed as invalid for
the new declaration, its old base becomes unavailable, and replacement is
interrupted after the provider effect. Restart resumes exactly one replacement
using the desired image and leaves the old generation unchanged. The test fails
on the previous code at the source-equality guard.

Additional tests cover target identity/revision/digest/profile drift, unavailable
targets, foreign/missing/unknown old state, unexpected old lineage, post-quiesce
lineage changes, same-image healthy rejection, and undeclared replacement output.
Existing missing-disk, invalid-disk, reset, recreate and fence/restart tests remain
applicable. Hosted tests prove these owner contracts; the pending native resume
and GitHub Hello World runs remain distinct operational evidence.
