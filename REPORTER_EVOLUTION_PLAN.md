# QOP Reporter — Next Evolution Plan

> Companion to `REPORTER_LIFECYCLE_DIAGRAMS.md`
> Current state: 4 WebSocket events. Target: full lifecycle observability.

---

## Architecture Layers

```
Reporter ──▶ WebSocket Protocol ──▶ automationServer.ts ──▶ DB (test_case_events)
  (add hooks)   (add event types)    (add handlers)         (mostly ready ✅)
```

---

## What's Already Ready

| Layer | Status | Notes |
|---|---|---|
| `test_case_events` table | ✅ Ready | Columns: event_type, step_name, payload (JSONB) — supports step_started, step_finished, log, attachment |
| `screenshots` table | ✅ Ready | screenshot_type: failure, step, custom |
| `test_case_executions` table | ⚠️ Partial | Needs retry_index, failure_type columns |
| WebSocket protocol | ❌ 4 events only | run_started, test_started, test_finished, run_finished |
| `automationServer.ts` | ❌ 4 handlers only | No step/log/phase handlers |
| Reporter plugins | ❌ Partial | Each uses 4-6 of available hooks |
| Frontend | ❌ Pass/fail only | No step timeline, no log viewer |

---

## Phase 1 — Step-Level Tracking

**New WebSocket events**: `step_started`, `step_finished`

```
step_started  { testId, stepName, stepType, line? }
step_finished { testId, stepName, status, durationMs, error? }
```

### Reporter changes per framework

**Playwright** — implement `onStepBegin`, `onStepEnd`
```typescript
onStepBegin(test: TestCase, result: TestResult, step: TestStep): void {
  this.send({ event: 'step_started', testId, stepName: step.title, stepType: step.category })
}
onStepEnd(test: TestCase, result: TestResult, step: TestStep): void {
  this.send({ event: 'step_finished', testId, stepName: step.title,
               status: step.error ? 'failed' : 'passed', durationMs: step.duration })
}
```

**Pytest** — implement `pytest_runtest_setup`, `pytest_runtest_teardown`
```python
def pytest_runtest_setup(item):
    send({ 'event': 'step_started', 'stepName': 'setup', 'stepType': 'fixture' })

def pytest_runtest_teardown(item, nextitem):
    send({ 'event': 'step_started', 'stepName': 'teardown', 'stepType': 'fixture' })
```

**TestNG** — implement `IConfigurationListener`
```java
public void onConfigurationSuccess(ITestResult result) {
    send(buildStepEvent("step_finished", result, "passed"));
}
public void onConfigurationFailure(ITestResult result) {
    send(buildStepEvent("step_finished", result, "failed"));
}
```

**Jest** — make `onTestCaseStart` real (currently no-op), add file-level hooks
```typescript
onTestFileStart(test: Test): void {
  this.send({ event: 'step_started', stepName: test.path, stepType: 'file' })
}
```

### Backend change — `automationServer.ts`
```typescript
case 'step_started':
  await db('test_case_events').insert({
    test_case_execution_id: executionId,
    event_type: 'step_started',
    step_name: payload.stepName,
    payload: { stepType: payload.stepType, line: payload.line }
  });
  break;

case 'step_finished':
  await db('test_case_events').insert({
    test_case_execution_id: executionId,
    event_type: 'step_finished',
    step_name: payload.stepName,
    payload: { status: payload.status, durationMs: payload.durationMs, error: payload.error }
  });
  break;
```

**DB migration needed**: None — `test_case_events` already supports this.

---

## Phase 2 — Console / Log Capture

**New WebSocket event**: `log`

```
log { testId, level: 'stdout'|'stderr'|'warn', message, timestamp }
```

### Reporter changes per framework

**Playwright** — implement `onStdOut`, `onStdErr`
```typescript
onStdOut(chunk: string|Buffer, test: TestCase|void, result: TestResult|void): void {
  if (test) this.send({ event: 'log', testId, level: 'stdout', message: chunk.toString() })
}
onStdErr(chunk: string|Buffer, test: TestCase|void, result: TestResult|void): void {
  if (test) this.send({ event: 'log', testId, level: 'stderr', message: chunk.toString() })
}
```

**Pytest** — implement `pytest_warning_recorded`
```python
def pytest_warning_recorded(warning_message, when, nodeid, location):
    send({ 'event': 'log', 'level': 'warn', 'message': str(warning_message.message), 'testId': nodeid })
```

**Jest** — parse stdout from `onTestCaseResult` result object
```typescript
// testCaseResult.console[] array already contains log entries
for (const entry of testCaseResult.console ?? []) {
  this.send({ event: 'log', testId, level: entry.type, message: entry.message })
}
```

### Backend change — `automationServer.ts`
```typescript
case 'log':
  await db('test_case_events').insert({
    test_case_execution_id: executionId,
    event_type: 'log',
    payload: { level: payload.level, message: payload.message, timestamp: payload.timestamp }
  });
  break;
```

**DB migration needed**: None — `test_case_events` event_type `log` already defined.

---

## Phase 3 — Setup / Teardown / Fixture Failure Tracking

**New WebSocket events**: `phase_started`, `phase_finished`

```
phase_started  { testId?, phaseName, phaseType: 'before'|'after'|'fixture'|'global' }
phase_finished { testId?, phaseName, phaseType, status, durationMs, error? }
```

This closes the biggest current gap: `@BeforeMethod` failures, pytest fixture crashes, and Playwright global errors are currently invisible to QOP.

### Reporter changes per framework

**Playwright** — implement `onError`
```typescript
onError(error: TestError): void {
  this.send({ event: 'phase_finished', phaseName: 'global', phaseType: 'global',
               status: 'failed', error: { message: error.message, stack: error.stack } })
}
```

**Pytest** — implement `pytest_fixture_setup`, `pytest_fixture_post_finalizer`
```python
def pytest_fixture_setup(fixturedef, request):
    send({ 'event': 'phase_started', 'phaseName': fixturedef.argname, 'phaseType': 'fixture' })

def pytest_fixture_post_finalizer(fixturedef):
    status = 'failed' if fixturedef.cached_result and fixturedef.cached_result[2] else 'passed'
    send({ 'event': 'phase_finished', 'phaseName': fixturedef.argname, 'phaseType': 'fixture', 'status': status })
```

**TestNG** — implement `IConfigurationListener`
```java
@Override
public void onConfigurationFailure(ITestResult result) {
    send(buildPhaseEvent("phase_finished", result, "failed",
         result.getMethod().isBeforeMethodConfiguration() ? "before" : "after"));
}
```

### DB migration needed
```sql
ALTER TABLE test_case_events ADD COLUMN phase_type VARCHAR(20);
-- values: before, after, fixture, global
```

---

## Phase 4 — Retry Index + Failure Type Differentiation

**Protocol change** — enrich `test_finished`:
```
test_finished { ..., retryIndex: 0, failureType: 'timeout'|'assertion'|'error'|'flaky' }
```

### Reporter changes per framework

**Playwright** — `result.retry` already available in `onTestEnd`
```typescript
onTestEnd(test: TestCase, result: TestResult): void {
  const failureType = result.status === 'timedOut' ? 'timeout'
                    : result.retry > 0 ? 'flaky'
                    : 'assertion';
  this.send({ event: 'test_finished', ..., retryIndex: result.retry, failureType })
}
```

**TestNG** — use `onTestFailedWithTimeout` (currently unused)
```java
@Override
public void onTestFailedWithTimeout(ITestResult result) {
    sendTestFinished(result, "failed", "timeout");
}
```

**Pytest** — implement `pytest_runtest_makereport`
```python
@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if call.excinfo and 'TimeoutError' in str(call.excinfo.type):
        report.failure_type = 'timeout'
```

### DB migration needed
```sql
ALTER TABLE test_case_executions ADD COLUMN retry_index INTEGER DEFAULT 0;
ALTER TABLE test_case_executions ADD COLUMN failure_type VARCHAR(20);
-- values: timeout, assertion, error, flaky
```

---

## Before vs After — Full Event Flow

```
TODAY                              NEXT EVOLUTION
──────────────────────             ──────────────────────────────────────────
run_started                        run_started
  test_started                       test_started
    [BLIND ZONE]                       phase_started { before }       ← Phase 3
                                       phase_finished { before }      ← Phase 3
                                       step_started { login }         ← Phase 1
                                       log { stdout: "navigating" }   ← Phase 2
                                       step_finished { login, 120ms } ← Phase 1
                                       step_started { assert }        ← Phase 1
                                       step_finished { assert, fail } ← Phase 1
                                       phase_started { after }        ← Phase 3
                                       phase_finished { after }       ← Phase 3
  test_finished                      test_finished { retryIndex: 1,   ← Phase 4
                                                     failureType: flaky }
run_finished                       run_finished
```

---

## DB Migrations Summary

| Migration | Change | Phase |
|---|---|---|
| `...017_add_phase_type_to_events.cjs` | `ALTER TABLE test_case_events ADD COLUMN phase_type VARCHAR(20)` | Phase 3 |
| `...018_add_retry_failure_type.cjs` | Add `retry_index`, `failure_type` to `test_case_executions` | Phase 4 |

---

## Frontend Work Required

| Feature | Phase | Component |
|---|---|---|
| Step timeline view inside test execution | Phase 1 | `/runs/[id]` detail page |
| Console log panel per test | Phase 2 | `/runs/[id]` detail page |
| Before/After phase status row | Phase 3 | test execution card |
| Retry badge (attempt 1/2/3) | Phase 4 | test execution card |
| Failure type tag (timeout / assertion / flaky) | Phase 4 | test execution card + filters |

---

## AI Analysis Evolution

With step-level data available:

- Trigger AI on `step_finished { status: failed }` — root cause at step level, not just test level
- Step name + error gives far more specific context to Claude/GPT
- Flaky detection can track which **step** is flaky across runs, not just which test
