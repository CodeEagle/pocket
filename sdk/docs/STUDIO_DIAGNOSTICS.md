# Studio crash and persistent log collection

Source inspection reused the retained parent's clipboard pattern in
`pocketjs_flutter_demo/pocketjs_super_app_demo.html` and the active SDK's
`PreviewSession.reportError`, native probe process boundary, and workspace
storage. The retained parent has no equivalent durable Studio crash journal.

Studio uses `packages/pocket_diagnostics` directly. One bounded JSONL journal
under `<workspace>/diagnostics/` retains errors across preview disposal, rebuild,
and Studio restart. It keeps at most 2,000 queryable records and four rotating
1 MiB segments (a bounded individual record may exceed a segment threshold).
Crash writes are flushed with fsync. There is no remote upload.

- Fatal preview errors retain the original message/stack, project, revision,
  runtime and last frame, plus the installed child identities.
- Unexpected native process exits are observed even while idle; retained stderr
  is included. Intentional `quit`/disposal does not create a crash record.
- Successful bytecode loads are lifecycle log entries. Recoverable rejected
  input is a warning log. Browser notices are error logs; browser `error` and
  `unhandledrejection` events produce crash records without swallowing errors.
- Frame bodies, texture bytes and every-frame events are not logged.

`GET /api/projects/<id>/diagnostics` returns a project-scoped export bundle.
`?kind=crash` selects crashes, and `?download=1` returns a downloadable JSON
file. Studio exposes this through **More → Export diagnostic records**
(`更多 → 导出诊断记录`). `POST` accepts a bounded browser report with `kind`,
`message`, optional `error` and `data`; the ordinary local Editor CSRF check
still applies. Browser reports cannot choose the authoritative project/source.

Validation: `editor/test/diagnostics.test.ts` exercises an actual child-process
exit with stderr while idle, startup failure before disposal, restart/reopen,
project-scoped export, input limits and CSRF. Package disk tests cover concurrent
writes, rotation and partial-tail recovery. Clipboard tests cover full error
copy, keyboard activation, fallback copy, close and delayed clipboard completion.

An already-dead process cannot report a new stack. SIGKILL/power loss may leave
only records written before termination; the journal recovers an incomplete
final line. This is local diagnostics, not an OS minidump collector.
