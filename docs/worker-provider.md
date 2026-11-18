# Worker execution provider (P3-7, P3-9, P3-10)

`WorkerExecutionProvider` (`maestro/adapters/worker/worker-exec-provider.ts`)
is the `ExecProvider` that runs Pi children as typed pi-worker children over
B2. It is opt-in: a host composes it explicitly as the shared Pi adapter's
`exec`. There is no flag, and terminal hosts are unchanged. It is not a
package export yet; P3-11 adds the worker exports and the installed-consumer
closure. Until then `@nublai/pi-worker-client` is a development dependency,
installed from the exact tarball in `vendor/pi-worker-client/` (source commit
and SHA-256 in `SOURCE.json`; root decision Q5). P3-10 rebuilt it from
pi-worker `b6e5a3c`, which serves `executions.interrupt` and
`artifacts.inspect` on the parent channel.

## Call path

| Exec operation | B2 |
| --- | --- |
| launch | `hello` once, `workers.get` (parent binding and running execution), then a durable slot claim and acquisition manifest, then `workers.create {parent, launch_spec}`. The initial `sessions.prompt` is its own command (never `first_prompt`). |
| inspect, reconcile | `workers.get`: `starting`, `ready` and `cleanup_pending` are live; `stopped` and `failed` are gone. |
| observe | `inspect`, woken by the client's `Observer` (one supervisor-wide stream, resumed from a snapshot after every break) or by the poll interval |
| read | `history.page`, every page (bounded), as text lines |
| prompt | `sessions.prompt`, `if_busy: reject` |
| interrupt | `executions.interrupt` |
| stop | `workers.stop`. The stop is confirmed only by `observed_stopped` or `superseded_generation_stopped` for the epoch it named. Anything else is reported unconfirmed and keeps the run owned. |
| parent admission (P3-9) | `workers.get` of the parent, then `sessions.prompt {if_busy: reject}` to it; a lost reply gets one `receipts.get`. See [Parent admission](#parent-admission-p3-9). |
| artifact facts (P3-10) | `artifacts.inspect {worker_epoch, commit, base}` of an owned child: owner-Git facts at the worker's saved launch pin, a read (no command). A refusal is typed; a lost reply is unavailable and never retried. See [Bound checks](#bound-checks-and-hand-offs-p3-10). |

Every mutation's UUIDv7 command ID and `requestHash` are written to the
launch's acquisition manifest (`<state>/launches/<launch>.json`, 0600) before
its bytes are sent. A lost reply is reconciled with one `receipts.get`. An
outcome that stays unknown is recorded and never sent again. Outcomes:

- If the create proves no effect, the manifest is removed and the slot claim
  released.
- If the create's outcome is unknown with no worker named, the launch rejects
  with `AcquisitionUncertainError` and keeps its manifest and slot.
- If a worker exists but the create or initial prompt is uncertain, or the
  prompt was refused, the launch returns that worker with `launchFailure`. It
  stays owned and is never retried.

The initial prompt text (`initialPrompt`, caller code that may fail) is
prepared before the slot claim: if it throws, the launch rejects with nothing
claimed or sent. Any other failure after `workers.create` returns the acquired
worker with `launchFailure`, never a plain rejection, and sends nothing more.

A store that fails once a command was sent never becomes a plain rejection,
which the shared owner would read as "nothing acquired" and could retry. The
provider writes nothing more to the failing store, sends nothing more, and
keeps the command (still `pending`, which a reader treats as unknown), the
manifest and the slot claim as they were:

- After `workers.create` (or the initial prompt) the launch returns the
  acquired worker with `launchFailure`; the shared adapter then stops it as a
  failed launch. A create whose outcome is unknown with no worker named still
  rejects with `AcquisitionUncertainError`.
- After a later `sessions.prompt` or `executions.interrupt`, the call rejects
  with `WorkerCommandUncertain` (never re-send), naming what the reply proved.
- After `workers.stop`, the report is unconfirmed, never a rejection. The next
  stop reads the worker's row again and confirms it without a new command.

## Capabilities

The provider supports managed worktrees (owner-prepared slots) only. Resume
(B2 refuses sandboxed-child resume), fork, persistent specialists, the
caller's checkout and caller surfaces are refused before acquisition.
Interactive children (a worker child has no terminal for a person) and
children that spawn subagents (a child's grant is `children.report` only) are
refused too, before any B2 call (P3-10).
`executionExit` is false because B2 reports status, not exit codes.
`parentAdmission` is `receipt` (P3-9): checked outcomes reach the parent
through `WorkerParentAdmission`, proven by B2 receipts.
A request that names skills is refused unless the host supplies a resource
mapping (`childSpec.resources`).

A child declares the bwrap profile of its slot (`childSpec.filesystem`,
default `bwrap`; `environment.root` is the slot). B2 then saves the launch's
Git pin, which `artifacts.inspect` needs, and the create is exactly the body
a sandboxed parent's channel would normalize it to, so its request hash is
the one B2 records. With `none` no pin is saved and every bound check fails
closed. (The real-B2 fixture's hosts run unsandboxed; only the declaration
and the pin are real there.)

The role identity is weaker than a system prompt here. B2's `LaunchSpec` has
no system-prompt field, so the identity is the initial prompt's preamble
(`workerInitialPrompt`): ordinary conversation input, not system
instructions. Root accepted this only as interim append semantics. A request
to replace the system prompt (`systemPromptMode: "replace"` with an identity)
is refused before acquisition. A typed `LaunchSpec` field comes before P3-12.

## Owner-prepared slots (Q3)

Before the parent starts, the owner makes each slot a locked linked worktree
of the parent's own repository at `PARENT/.piw-slots/<name>`, on its own
`refs/heads/<namespace>/<leaf>` branch at an exact base. The owner lists the
slots in a manifest:

```json
{ "version": 1, "kind": "maestro-worker-slots",
  "slots": [{ "name": "a", "branch": "refs/heads/job/a", "baseSha": "<40 hex>" }] }
```

`WorkerSlotPool` checks the chosen slot with plain file reads; it runs no
`git` process and makes no Git administrative writes. A valid slot is:

- a real directory, not a symlink;
- a linked worktree whose common directory is the parent's;
- registered back to its own path;
- locked;
- on its branch, with that branch at the slot's base.

The pool claims the slot durably (`<state>/slots/<name>.claim`, created
exclusively and fsynced). The claims directory must lie outside
`PARENT/.piw-slots` and be reached through real directories only: every
component of its path is checked with `lstat` (and made one level at a time)
at construction and before each claim, read and release, so no symbolic link
can put a claim inside a slot, where its child could delete it. A claim file
is read without following a link. Node has no `openat`; swapping a component
between the check and the use needs a writer outside every slot.

A requested branch selects the slot whose leaf matches it, otherwise the
first free slot. A requested base other than `HEAD` must equal the slot's
base. An exhausted pool or a mismatched slot is refused before
`workers.create`: only the `hello` and the parent's `workers.get` (reads) come
first. A mismatched slot is refused, never skipped.

## Reports: FD 3 only

The leaf reports with `FdReporter` (`maestro/adapters/worker/fd-report.ts`),
writing one JSON line `{report_id, kind, message}` to the descriptor named by
`PI_WORKER_REPORT_FD` (pi-worker sets 3). The reporter imports `node:fs` only:
no client, grant, engine or runtime. `check:boundaries` enforces this for the
source and the emitted file. A `result` message is a versioned claim
(`encodeResultClaim`); it may name the full object ID of the commit the child
claims as its result (`commit`), which the bound check compares with what
owner Git reads. The provider reads the claim back from the child's row
and transcribes the first `result` claim into the run's parent-local
completion record, the `.exit` sidecar the shared adapter reads, after
mirroring the child's history there. An undecodable claim completes as an
error. A `help` claim becomes its own outcome (see below). A claim is never
proof.

## Parent admission (P3-9)

A checked outcome reaches the parent as input to its own session, proven by
its receipt. Three parts compose it:

- The parent's `FileOutcomeStore` (owner-provisioned `.piw-maestro/`
  directory) is opened with the parent identity
  `workerParentIdentity({worker_id, worker_epoch, session_id})`. A relaunched
  or rebound parent is a different parent: its store must be adopted
  explicitly (`adopt: true`), never redirected because the cwd or name
  matches.
- `WorkerParentAdmission` (`provider.parentAdmission(binding)`, the provider's
  own client and grant) reads the parent's row and prepares one
  `sessions.prompt {if_busy: reject}` with a fresh UUIDv7 command ID and the
  request hash, only to an idle, unfenced, `ready` parent of that identity.
  The message is the outcome's persisted envelope (`maestro-outcome/v1`: kind,
  delivery ID, task, attempt, outcome, verdict, then the bounded text).
- `AdmissionOutbox` (`maestro/runtime/admission-outbox.ts`) owns delivery.
  The run owner hands it each committed outcome (`RunSession` option
  `parentAdmission`; `onSettled` is then only a notification). It records
  `dispatching` with the command ID and request identity before sending, and
  settles by what the reply or receipt proves:

| Evidence | Outcome |
| --- | --- |
| The parent is busy or B2 is unreachable (before any send) | Waits in the outbox, nothing written. |
| The parent is fenced, stopped (or ending), missing or rebound | `blocked` with the reason; retried when a later read shows it clear. A fence is never cleared here, and no parent is relaunched or replaced. |
| A matching `delivered` receipt, `effect: observed`, `admission: accepted` | `admitted` with `receipt` evidence and the receipt's identity. Never resent. |
| A refusal (`worker_busy`, `session_fenced`, `stale_binding`, ...) | `blocked`; the next attempt has a new command ID. A refusal whose cause cannot clear by itself waits for the owner. |
| A lost reply, `outcome_unknown`, a missing, expired or scope-denied receipt, a receipt for another request, a receipt not saying `accepted` | `uncertain`. Never sent again. Unsettled receipts are read again; the others wait for the owner. |

On start (`outbox.start()`), every recovered `uncertain` attempt, a
`dispatching` left by a crash included, is read back by its receipt before
anything new is sent: an admission whose local ack was lost becomes
`admitted`, a proven refusal becomes `blocked`, anything else stays uncertain.
`attention()` lists every outcome still held and what it needs; the owner
ends an uncertain one only with `abandon(deliveryId, reason)`. This proves the
parent's input admission, not that the parent read or acted on the outcome
(root decision Q2).

Help requests are not completions. Each FD 3 `help` claim the provider's
Observer surfaces becomes its own outcome (`kind: help`, keyed by the
report's command ID, never taking the run's result slot or closing it),
committed in the same store record as the Observer's state
(`workerObserverPersistence`). The first snapshot without a saved state
(a cold seed: the Observer's first ever, or a restart with nothing saved)
counts every report already on a row as seen without naming it, so the
persistence retains the owned children's help requests listed there in the
same record; a child that asks for help before that snapshot is not lost. A
restarted parent restores the saved state (`observer.restored`) and resumes
observation (`resumeObservation()`), so a help request is neither lost nor
delivered twice. The parent answers through
the child's own `sessions.prompt` (B2 refuses resume); wiring that answer to
the public tools is host composition (P3-11).

## Bound checks and hand-offs (P3-10)

A worker parent composes `WorkerRunChecks`
(`maestro/adapters/worker/run-checks.ts`) as its run owner's `operations` and
`hooks`, with its `OutcomeStore` and `AdmissionOutbox`. Each run launches
through the shared Pi adapter (the run's task ID is the child's B2 task, so a
restarted owner finds its launch), and a requested accept check is the V1
bound check (`runWorkerBoundCheck`, `bound-check.ts`), never the terminal
re-check:

1. Only a completed run with a `done` result claim is checked; a failed or
   missing report is `skipped`, a completion without a result claim `error`.
2. The child's termination is confirmed first, for the generation that ran: a
   stop confirms only for the epoch it named (or a row already stopped). A
   stop B2 did not observe (unconfirmed, sent or maybe sent) is repeated, at
   most three stops in all; a stop never sent is not. Unconfirmed: `error
   (child termination not confirmed)`, nothing read, the report and the
   worker kept.
3. `artifacts.inspect` at that epoch for the slot's branch and issued base.
   The subject binds only when the facts name this worker and generation, the
   base is the issued one and an ancestor, HEAD and the pin's HEAD are the
   issued branch, HEAD is the branch's commit, a claimed commit is that
   commit, and the checkout is clean but for the worker's own runtime
   directories (`.piw-agent/`, `.piw-worker/`, untracked, listed by name in
   the subject). A conflicted, dirty or truncated status, a pin mismatch, a
   missing object, a refused or unanswered inspection: `error` with the
   reason, and the command does not run.
4. The subject (commit, tree, base, branch, root, pin identity, Git version,
   replace objects disabled, runtime directories) is recorded
   (`recordCheck`) before the approved command runs with Maestro's
   parent-side accept runner (`sh -c` in the slot, in the parent's process
   and sandbox, never a worker or daemon shell), cancellable.
5. After it the same inspection must read the same subject and checkout
   status; anything else is `error (subject changed ...)`, the command's exit
   kept as evidence. Otherwise the exit decides: `accepted` or `rejected`,
   both bound.

A cancel that wins during the check is `skipped (cancelled)` (`check:
cancelled`), its own outcome; the run then delivers the cancelled result.

The committed outcome keeps, in the OutcomeStore:

- `verdict`: verdict, `bound`, command hash (never the command), exit or
  result kind, timeout, environment (runner, shell, cwd; variable names
  only), termination (request, confirmation, stops, epoch), the claimed
  commit and the report ID;
- `subject`: `before` and `after`, as read;
- `facts.handoff`: the worker, slot, branch and base; the result and help
  report IDs; every command the launch sent and what it proved; the child's
  row; the parent's row (`fenced`, its fence's command ID) apart from it,
  with `may_take_input` and, when fenced, `needs: owner-reconciliation`; the
  durable cancel intent.

Hand-offs, not new child results:

- A cancel records its intent in the launch manifest (`onCancelState`,
  synchronously) before the stop is sent; the outcome carries the
  cancellation facts and the stop evidence.
- Invariant 4a is kept: a child stopped or gone without a result report
  fences its parent. The hand-off names the fence and asks for owner
  reconciliation; the outbox holds the outcome (`attention()`). Nothing here
  clears a fence or relaunches.
- An unconfirmed stop keeps the child's report (its text and report ID) and
  the worker owned.
- One run's failure is its own outcome: a sibling's check, subject and
  verdict are its own.
- A run a previous owner left open (a restart) is handed off by
  `handOffInterrupted(store, outbox)`: one host-authored `interrupted`
  outcome with the saved check subject (`error (check interrupted)`; the
  check is never re-run), the launch's commands, the cancel intent and
  whether the child is now stopped, and the parent's state; then that run is
  closed. A hand-off committed before a lost close is not committed again.
  The current owner's own live runs are never handed off.

## Grant profile

`MAESTRO_WORKER_PARENT_METHODS` lists the methods the provider calls, plus
`children.report` (the ceiling a typed child's spec must fit under):

- `hello`
- `workers.get`
- `receipts.get`
- `events.subscribe`
- `history.page`
- `artifacts.inspect`
- `workers.create`
- `sessions.prompt`
- `executions.interrupt`
- `workers.stop`
- `children.report`

It contains no `*`, no owner reconciliation, and no steering or follow-up. A
child's spec grants `children.report` only.

## Tests

- `npm test` runs the unit cases: the reporter and its import and authority
  boundary, slots, manifests, the grant closure, the real-B2 lane's source
  check and the V1 bound check over a fake port
  (`worker-bound-check.test.ts`).
- `npm run test:worker-b2` runs the `ExecProvider` conformance suite, including
  the adapter-boundary cases, plus the provider's and the parent admission's
  B2 tests (`b2-admission.test.ts`: the O1 crash cuts with the Maestro process
  SIGKILLed and restarted, B2 restarts, lost replies, fences, wrong, rebound
  and stopped parents, expired and denied receipts, help requests; and the
  interrupted-run hand-offs after a SIGKILL during a check and before a
  cancel's stop) and the bound checks (`b2-bound-check.test.ts`: V1 against
  an actual child commit compared with the owner's own Git, over the owner
  socket and over a sandboxed parent's channel; a tree changed by the check,
  a pin mismatch, a missing object, a lost inspect reply, a dirty checkout, a
  wrong claimed commit; failed and missing reports, a cancelled check, a
  cancel before any report, sibling isolation with an unconfirmed stop),
  against pi-worker's real supervisor and B2 server.
  - B2 confirms a stop only once the child's leader process is proven gone.
    Under load a leader can be a zombie whose last thread is still exiting;
    that stop is `outcome_unknown` (the worker stays owned) and the provider
    reports it unconfirmed. The tests accept it: they stop again, as an owner
    may, and a later stop confirms (or finds that B2 observed the exit). Only
    a stop whose B2 receipt is `outcome_unknown` is repeated, at most three
    stops per execution. The conformance fixture declares this with
    `unobserveNextStop`; the kit then repeats a stop only after an
    unconfirmed report, never after a rejection or another error.
  - It runs from a built checkout named by `MAESTRO_PI_WORKER_CHECKOUT`, and
    refuses one that is not at the commit in `SOURCE.json`, has tracked or
    untracked changes, or whose `dist` is not byte for byte what that tree
    compiles to (`scripts/pi-worker-checkout.ts` compiles in memory with the
    checkout's own TypeScript; files the build copies must equal their
    tracked sources). The test files refuse to start unless the runner
    verified the checkout.
  - Typed children are real subprocesses with the FD 3 pipe, and they report
    with Maestro's reporter.
  - It refuses to run without the checkout, and CI does not run it yet.

## Root decisions and known gaps

Root decided the three open items on 2026-11-18:

1. Parent-channel interrupt. Landed in pi-worker `b6e5a3c` (#43), scoped
   like the other channel methods. The interrupt path is unchanged; the B2
   test that recorded the gap is flipped and the provider interrupts a child
   through a sandboxed parent's channel.
2. Role identity. The first-prompt preamble is interim, for append semantics
   only; replace is refused (see Capabilities). A typed `LaunchSpec` field
   comes before P3-12.
3. Invariant 4a is kept. Stopping a child that has no result report fences
   its parent until the owner resolves it; the provider neither clears the
   fence nor launches a replacement, and a B2 test pins this. P3-10 owns the
   cancellation and failure handoff: keep the cancel intent, the command and
   stop evidence and the checked outcomes; expose the parent fence and
   require owner reconciliation; never make up a child result. A confirmed
   child stop and a parent that may take more input are separate facts.
   Implemented in P3-10 (see [Bound checks](#bound-checks-and-hand-offs-p3-10)).

Still open:

- The slot is not yet projected onto `AgentHandle.worktree`; the bound check
  reads it from the launch manifest (`runBinding`) and the commit through
  `artifacts.inspect`.
- Pi composition (`createDefaultRunSession`) does not pass `parentAdmission`
  yet, and `subagent_send` cannot answer a non-persistent worker child; both
  belong to the worker parent's host composition (P3-11).
- A run interrupted by a restart is handed off (`handOffInterrupted`), not
  re-attached to its still-running worker child; stopping that child is the
  owner's.
