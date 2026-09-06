# Windows lifecycle client disconnect recovery

The September 6 protected setup applied the current service and closed the
superseded Linux create, but the invalid Linux system disk still required an
owned rebuild. A read-only diagnostic client then disconnected while waiting
for its result. Windows recorded a lifecycle service FailFast and restarted it.
Local evidence is retained in `ho195-service-failfast-events.json` and
`ho195-protected-apply.log`.

The native pipe owner checked `IsConnected` before disconnecting its reusable
server. A broken client makes that property false, although the server still
needs `Disconnect` before accepting another caller. Microsoft's
[IsConnected contract](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.pipestream.isconnected)
includes broken connections among false states, and the
[NamedPipeServerStream source](https://source.dot.net/System.IO.Pipes/System/IO/Pipes/NamedPipeServerStream.cs.html)
allows disconnecting a broken pipe while rejecting a new connection in that
state. The compiled Windows regression independently reproduced the failure
on the installed framework.

The existing native host now disconnects each accepted client, including a
broken one, while retaining its exclusive first pipe instance. Ingress timeout
and I/O failures close only that client; pending reads are cancelled before
reuse. Unexpected host failures still fail closed and now include their
exception in the local Windows event log. Endpoint ACLs, framing, worker
protocols, response bounds, and authority remain unchanged.

The existing compiled-host test now abandons empty, truncated, idle, and
complete requests, then checks that the same host accepts a normal request
after each case. It retains its large-response and consecutive lifecycle,
configuration, and activity requests. The new regression failed before the
repair (`ho195-pipe-regression-before.log`); all eight focused tests passed
after it (`ho195-pipe-focused.log`). Final-source preflight is retained in
`ho195-pipe-preflight.log`. Live service installation and Linux rebuild remain
separate acceptance steps; these checks do not claim Hello World execution.
